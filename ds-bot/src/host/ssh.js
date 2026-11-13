// SSH tools: connect to a remote server, run commands, and transfer files.
// Passwords and private keys come from the team's secrets store (request_secret);
// they are never tool arguments, and they are stripped from results and errors.
// Host keys are checked on every new connection (trust on first use): the
// fingerprint is saved under the team home and a later mismatch is refused.
import { isUtf8 } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Client as Ssh2Client } from 'ssh2'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { replaceFile } from './files.js'
import { normalizeName, SECRET_NAME } from './secrets.js'
import { output } from './tools.js'

export const SSH_TOOLS = [
  'ssh_connect',
  'ssh_exec',
  'ssh_read',
  'ssh_write',
  'ssh_upload',
  'ssh_download',
  'ssh_disconnect',
]
export const KNOWN_HOSTS_FILE = 'known-hosts.json'
export const DEFAULT_PORT = 22
const CONNECT_TIMEOUT_MS = 20_000
const EXEC_TIMEOUT_MS = 60_000
const TRANSFER_TIMEOUT_MS = 120_000
const EXEC_OUTPUT_MAX = 200_000
const READ_TEXT_MAX = 256 * 1024
const WRITE_TEXT_MAX = 1024 * 1024
const PLAIN_AUTH_FIELDS = ['password', 'private_key', 'privateKey', 'passphrase', 'key', 'identity']

const PRIVATE_KEY_BLOCK = /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g

export function fingerprintOf(key) {
  if (typeof key === 'string' && key.startsWith('SHA256:')) return key
  if (typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key)) {
    return `SHA256:${Buffer.from(key, 'hex').toString('base64').replace(/=+$/, '')}`
  }
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key ?? ''), 'utf8')
  return `SHA256:${createHash('sha256').update(buf).digest('base64').replace(/=+$/, '')}`
}

export function hostIdOf(host, port = DEFAULT_PORT) {
  return `${String(host).trim().toLowerCase()}:${Number(port) || DEFAULT_PORT}`
}

export function parseTarget(args = {}) {
  const rawHost = String(args.host ?? '').trim()
  const username = String(args.username ?? args.user ?? '').trim()
  const portRaw = args.port
  const port = portRaw === undefined || portRaw === null || portRaw === ''
    ? DEFAULT_PORT
    : typeof portRaw === 'number' ? portRaw : Number(String(portRaw).trim())
  if (rawHost === '') return { error: 'Give the server address (host).' }
  if (username === '') return { error: 'Give the username to sign in as.' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'Port must be an integer from 1 to 65535. The default is 22.' }
  }
  const host = rawHost.toLowerCase()
  return { host, port, username, label: `${username}@${host}:${port}`, hostId: hostIdOf(host, port) }
}

export function connectionKey(botId, target) {
  return `${botId ?? ''}::${target.username}@${target.host}:${target.port}`
}

function secretNameOf(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined
  const name = normalizeName(raw)
  if (!SECRET_NAME.test(name)) return { error: `"${String(raw).trim()}" is not a valid secret name. Use capitals, digits, and underscores, starting with a letter.` }
  return { name }
}

export function rejectPlainAuth(args = {}) {
  for (const field of PLAIN_AUTH_FIELDS) {
    const value = args[field]
    if (value !== undefined && value !== null && String(value) !== '') {
      return 'Do not pass a password or private key to this tool. Save it with request_secret and pass the secret name (password_secret or key_secret).'
    }
  }
  return undefined
}

export async function resolveAuth(rt, botId, args = {}) {
  const plain = rejectPlainAuth(args)
  if (plain) return { error: plain }
  const passwordRef = secretNameOf(args.password_secret)
  if (passwordRef?.error) return { error: passwordRef.error }
  const keyRef = secretNameOf(args.key_secret)
  if (keyRef?.error) return { error: keyRef.error }
  const passRef = secretNameOf(args.passphrase_secret)
  if (passRef?.error) return { error: passRef.error }
  if (passwordRef === undefined && keyRef === undefined) {
    return { error: 'Say how to log in: give password_secret and/or key_secret, the name of a key already saved with request_secret. Do not put the password or private key in the chat or in this tool.' }
  }
  await rt.loadSecrets?.()
  const take = (ref, label) => {
    if (ref === undefined) return { ok: true, value: undefined }
    const name = ref.name
    const value = rt.secretValue?.(name)
    if (typeof value !== 'string' || value === '') {
      return { error: `${name} is not saved yet. Ask for it with request_secret.` }
    }
    if (typeof rt.canUseSecret === 'function' && !rt.canUseSecret(name, botId)) {
      return { error: `You may not use ${name}. Ask for access with request_secret.` }
    }
    return { ok: true, name, value, label }
  }
  const password = take(passwordRef, 'password')
  if (password.error) return password
  const key = take(keyRef, 'key')
  if (key.error) return key
  const passphrase = take(passRef, 'passphrase')
  if (passphrase.error) return passphrase
  if (passRef !== undefined && keyRef === undefined) {
    return { error: 'passphrase_secret is only used with key_secret.' }
  }
  return {
    passwordName: password.name,
    keyName: key.name,
    passphraseName: passphrase.name,
    password: password.value,
    privateKey: key.value,
    passphrase: passphrase.value,
  }
}

export function sanitizeText(text, secrets = [], redact = value => value) {
  let out = redact(String(text ?? '')) ?? String(text ?? '')
  const values = secrets
    .filter(value => typeof value === 'string' && value.length >= 4)
    .sort((a, b) => b.length - a.length)
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join('[secret]')
  }
  return out.replace(PRIVATE_KEY_BLOCK, '[secret]')
}

const callerOf = (rt, exec) => rt.selfOf?.(exec?.agent?.session?.header?.id ?? exec?.agent?.id)

export function attachSsh(rt, deps = {}) {
  const Client = deps.Client ?? rt.config?.ssh?.Client ?? Ssh2Client
  const home = rt.home
  const knownPath = join(home, KNOWN_HOSTS_FILE)
  /** @type {Map<string, {host:string, port:number, fingerprint:string, firstSeenAt:number, lastSeenAt:number}>} */
  const known = new Map()
  let loaded = false
  let blocked
  let writing = Promise.resolve()
  /** @type {Map<string, {client:any, target:object, botId:string, authNames:object, fingerprint?:string}>} */
  const pool = new Map()
  /** @type {Map<string, {passwordName?:string, keyName?:string, passphraseName?:string}>} */
  const lastAuth = new Map()
  /** @type {Map<string, Promise<any>>} */
  const opening = new Map()

  const valuesOf = auth => [auth?.password, auth?.privateKey, auth?.passphrase].filter(Boolean)
  const clean = (text, auth) => sanitizeText(text, valuesOf(auth), rt.redactSecrets ?? (value => value))

  const loadKnown = async () => {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(knownPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.hosts)) {
        blocked = 'unreadable'
        throw new Error('The saved host-key file is not in the expected format. H bot does not change it; fix or move the file and reload.')
      }
      known.clear()
      for (const entry of parsed.hosts) {
        if (entry === null || typeof entry !== 'object') continue
        const host = typeof entry.host === 'string' ? entry.host.trim().toLowerCase() : ''
        const port = Number.isInteger(entry.port) ? entry.port : DEFAULT_PORT
        const fingerprint = typeof entry.fingerprint === 'string' ? entry.fingerprint : ''
        if (!host || !fingerprint) continue
        known.set(hostIdOf(host, port), {
          host,
          port,
          fingerprint,
          firstSeenAt: Number(entry.firstSeenAt) || Date.now(),
          lastSeenAt: Number(entry.lastSeenAt) || Date.now(),
        })
      }
      try { chmodSync(knownPath, 0o600) } catch {}
    } catch (error) {
      if (error?.code === 'ENOENT') {
        known.clear()
        return
      }
      if (blocked === 'unreadable') throw error
      blocked = error?.message ?? String(error)
      throw new Error(`The saved host-key file could not be read (${clean(blocked)}). H bot does not change it; fix or move the file and reload.`)
    }
  }

  const persistKnown = () => {
    if (blocked !== undefined) return Promise.reject(new Error(`The saved host-key file could not be updated (${clean(blocked)}).`))
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) return Promise.reject(new Error(readOnly))
    const snapshot = JSON.stringify({
      version: 1,
      hosts: [...known.values()].sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port),
    }, null, 2)
    const job = writing.then(async () => {
      await mkdir(home, { recursive: true })
      const temp = `${knownPath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await chmod(temp, 0o600)
        await replaceFile(temp, knownPath)
        try { await chmod(knownPath, 0o600) } catch {}
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    writing = job.catch(error => rt.warn?.('ds-bot: ssh known-hosts write failed (%s)', clean(error?.message ?? error)))
    return job
  }

  // Returns { ok, fingerprint, firstSeen } or { error }.
  const checkHostKey = async (target, key) => {
    await loadKnown()
    const fingerprint = fingerprintOf(key)
    const id = target.hostId
    const saved = known.get(id)
    if (saved !== undefined && saved.fingerprint !== fingerprint) {
      return {
        error: `Connection refused: the host key for ${target.host}:${target.port} does not match the one saved earlier. This can mean the server was rebuilt, or someone is intercepting the connection. The saved key was not changed.`,
        fingerprint,
        saved: saved.fingerprint,
        mismatch: true,
      }
    }
    if (saved === undefined) {
      const readOnly = rt.readOnly?.()
      if (readOnly !== undefined) return { error: `The host key for ${target.host}:${target.port} has not been saved yet, and H bot cannot record it now: ${readOnly}` }
      if (blocked !== undefined) return { error: `The host key for ${target.host}:${target.port} has not been saved yet, and the host-key file cannot be updated.` }
      return { ok: true, fingerprint, firstSeen: true }
    }
    saved.lastSeenAt = Date.now()
    return { ok: true, fingerprint, firstSeen: false }
  }

  const recordHostKey = async (target, fingerprint) => {
    const id = target.hostId
    const existing = known.get(id)
    if (existing !== undefined) {
      existing.lastSeenAt = Date.now()
      return persistKnown().catch(() => {})
    }
    const now = Date.now()
    known.set(id, { host: target.host, port: target.port, fingerprint, firstSeenAt: now, lastSeenAt: now })
    await persistKnown()
  }

  const drop = (key) => {
    const entry = pool.get(key)
    if (entry === undefined) return
    pool.delete(key)
    try { entry.client.end() } catch {}
  }

  const closeAll = () => {
    for (const key of [...pool.keys()]) drop(key)
  }

  const openClient = (target, auth) => new Promise((resolveOpen, reject) => {
    const client = new Client()
    let settled = false
    let verified
    const fail = (error) => {
      if (settled) return
      settled = true
      try { client.end() } catch {}
      const err = error instanceof Error ? error : new Error(String(error))
      err.message = clean(err.message, auth)
      reject(err)
    }
    client.on('ready', () => {
      if (settled) return
      settled = true
      resolveOpen({ client, verified })
    })
    client.on('error', fail)
    const hostVerifier = (key, verify) => {
      // Do not return a Promise: ssh2 treats a non-undefined return as the answer.
      Promise.resolve()
        .then(() => checkHostKey(target, key))
        .then((result) => {
          if (result?.error) {
            // Reject first so a follow-on 'error' from the client cannot hide this reason.
            fail(Object.assign(new Error(result.error), { mismatch: result.mismatch === true }))
            if (typeof verify === 'function') verify(false)
            return
          }
          verified = result
          if (typeof verify === 'function') verify(true)
        })
        .catch((error) => {
          if (typeof verify === 'function') verify(false)
          fail(error)
        })
    }
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.username,
        ...(auth.password !== undefined ? { password: auth.password } : {}),
        ...(auth.privateKey !== undefined ? { privateKey: auth.privateKey } : {}),
        ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
        readyTimeout: CONNECT_TIMEOUT_MS,
        keepaliveInterval: 15_000,
        hostVerifier,
      })
    } catch (error) {
      fail(error)
    }
  })

  const connect = async (botId, target, auth) => {
    const key = connectionKey(botId, target)
    const existing = pool.get(key)
    if (existing?.client !== undefined) return { ...existing, reused: true }
    if (opening.has(key)) return opening.get(key)
    const job = openAndStore(botId, target, auth, key)
    opening.set(key, job)
    try { return await job } finally { opening.delete(key) }
  }

  const openAndStore = async (botId, target, auth, key) => {
    const existing = pool.get(key)
    if (existing?.client !== undefined) return { ...existing, reused: true }
    const { client, verified } = await openClient(target, auth)
    if (verified?.firstSeen === true) {
      try {
        await recordHostKey(target, verified.fingerprint)
      } catch (error) {
        try { client.end() } catch {}
        throw new Error(`Could not save the host key for ${target.host}:${target.port}, so the connection was not opened. ${clean(error.message, auth)}`)
      }
    } else if (verified?.fingerprint !== undefined) {
      void recordHostKey(target, verified.fingerprint)
    }
    const authNames = { passwordName: auth.passwordName, keyName: auth.keyName, passphraseName: auth.passphraseName }
    lastAuth.set(key, authNames)
    const entry = {
      client,
      target,
      botId,
      authNames,
      fingerprint: verified?.fingerprint,
    }
    const stale = () => { if (pool.get(key) === entry) pool.delete(key) }
    client.on('close', stale)
    client.on('end', stale)
    pool.set(key, entry)
    return { ...entry, reused: false, firstSeen: verified?.firstSeen === true }
  }

  const requireBot = (exec, name) => {
    const botId = callerOf(rt, exec)
    if (rt.botOf?.(botId) === undefined) return { error: `Only Bots on the team can use ${name}.` }
    return { botId }
  }

  const targetOrError = (args) => {
    const target = parseTarget(args)
    if (target.error) return target
    return target
  }

  const authFromNames = async (botId, names = {}, args = {}) => {
    const merged = {
      password_secret: args.password_secret ?? names.passwordName,
      key_secret: args.key_secret ?? names.keyName,
      passphrase_secret: args.passphrase_secret ?? names.passphraseName,
    }
    return resolveAuth(rt, botId, { ...args, ...merged })
  }

  const getSession = async (botId, args, { connectIfNeeded = true } = {}) => {
    const plain = rejectPlainAuth(args)
    if (plain) return { error: plain }
    const target = targetOrError(args)
    if (target.error) return target
    const key = connectionKey(botId, target)
    const existing = pool.get(key)
    if (existing?.client !== undefined) return { ...existing, target, reused: true }
    if (!connectIfNeeded) return { error: `Not connected to ${target.label}. Call ssh_connect first.`, target }
    const auth = await authFromNames(botId, lastAuth.get(key) ?? existing?.authNames, args)
    if (auth.error) {
      if (rejectPlainAuth(args)) return auth
      if (!args.password_secret && !args.key_secret) {
        return { error: `Not connected to ${target.label}. Call ssh_connect first (password and keys stay in request_secret; pass only the secret name).`, target }
      }
      return auth
    }
    try {
      const session = await connect(botId, target, auth)
      return { ...session, auth }
    } catch (error) {
      return { error: clean(error.message, auth), mismatch: error.mismatch === true, target }
    }
  }

  const asText = (buffer) => {
    if (buffer.length === 0) return ''
    if (!isUtf8(buffer) || buffer.includes(0)) return undefined
    return buffer.toString('utf8')
  }

  const execCommand = (client, command, timeoutMs, auth) => new Promise((resolveExec, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The command timed out after ${Math.round(timeoutMs / 1000)} seconds.`))
    }, timeoutMs)
    timer.unref?.()
    client.exec(command, (error, stream) => {
      if (error) {
        clearTimeout(timer)
        reject(new Error(clean(error.message, auth)))
        return
      }
      const stdout = []
      const stderr = []
      let size = 0
      const take = (chunks, data) => {
        chunks.push(Buffer.from(data))
        size += data.length ?? Buffer.byteLength(data)
      }
      stream.on('data', data => take(stdout, data))
      stream.stderr?.on('data', data => take(stderr, data))
      stream.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(clean(err.message, auth)))
      })
      stream.on('close', (code, signal) => {
        clearTimeout(timer)
        const out = Buffer.concat(stdout)
        const err = Buffer.concat(stderr)
        let stdoutText = out.toString('utf8')
        let stderrText = err.toString('utf8')
        let clipped = false
        if (stdoutText.length + stderrText.length > EXEC_OUTPUT_MAX) {
          const room = Math.max(1000, Math.floor(EXEC_OUTPUT_MAX / 2))
          stdoutText = stdoutText.slice(0, room)
          stderrText = stderrText.slice(0, room)
          clipped = true
        }
        resolveExec({
          code: Number.isInteger(code) ? code : null,
          signal: signal ?? null,
          stdout: clean(stdoutText, auth),
          stderr: clean(stderrText, auth),
          clipped,
        })
      })
    })
  })

  const withSftp = (client, auth, work) => new Promise((resolveSftp, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(new Error(clean(error.message, auth)))
        return
      }
      Promise.resolve(work(sftp)).then(resolveSftp, (err) => {
        reject(err instanceof Error ? new Error(clean(err.message, auth)) : err)
      })
    })
  })

  const streamRead = (sftp, remotePath) => new Promise((resolveRead, reject) => {
    const chunks = []
    let size = 0
    const stream = sftp.createReadStream(remotePath)
    stream.on('data', (data) => {
      size += data.length
      if (size > READ_TEXT_MAX + 1) {
        stream.destroy()
        reject(Object.assign(new Error('too large'), { tooLarge: true, size }))
        return
      }
      chunks.push(Buffer.from(data))
    })
    stream.on('error', reject)
    stream.on('end', () => resolveRead(Buffer.concat(chunks)))
  })

  const streamWrite = (sftp, remotePath, contents) => new Promise((resolveWrite, reject) => {
    const stream = sftp.createWriteStream(remotePath)
    stream.on('error', reject)
    stream.on('close', resolveWrite)
    stream.end(contents)
  })

  const transfer = (sftp, method, src, dest, timeoutMs, auth) => new Promise((resolveTransfer, reject) => {
    const timer = setTimeout(() => reject(new Error(`The transfer timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs)
    timer.unref?.()
    sftp[method](src, dest, (error) => {
      clearTimeout(timer)
      if (error) reject(new Error(clean(error.message, auth)))
      else resolveTransfer()
    })
  })

  const localFrom = async (exec, input, { mustExist = false, forWrite = false } = {}) => {
    const text = String(input ?? '').trim()
    if (text === '') throw new Error('Give a local file path.')
    const botId = callerOf(rt, exec)
    const roomId = rt.groupOwners?.get(exec?.agent?.id)?.roomId
    const base = rt.sessionFolder?.(exec?.agent?.session)
      ?? rt.workDirOf?.({ botId, roomId })
      ?? rt.teamFolder?.()
      ?? process.cwd()
    const expanded = text === '~' ? requireHome() : /^~[\\/]/.test(text) ? join(requireHome(), text.slice(2)) : text
    const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
    const real = await (rt.realBeyond?.(resolved) ?? Promise.resolve(resolved))
    if (typeof rt.inData === 'function' && await rt.inData(real)) {
      throw new Error('That local path is in H bot data, so it cannot be used for SSH file transfer.')
    }
    if (mustExist) {
      const info = await stat(real).catch(() => undefined)
      if (info === undefined || !info.isFile()) throw new Error(`There is no file at ${text}.`)
    }
    if (forWrite) {
      // Parent folders are created by the caller if needed; we only block team data.
    }
    return real
  }

  const requireHome = () => homedir()

  const formatExec = (target, result, command) => {
    const lines = [`Ran on ${target.label}: ${command}`]
    if (result.code !== null) lines.push(`exit ${result.code}`)
    if (result.signal) lines.push(`signal ${result.signal}`)
    if (result.stdout) lines.push(result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout)
    if (result.stderr) lines.push(result.stdout ? `stderr:\n${result.stderr}` : result.stderr)
    if (!result.stdout && !result.stderr) lines.push('(no output)')
    if (result.clipped) lines.push('Output was truncated.')
    return lines.join('\n')
  }

  const tools = [
    defineTool({
      name: 'ssh_connect',
      description: 'Open an SSH connection to a remote server for running commands and transferring files. Reuses a live connection to the same host, port, and username. Authentication uses a secret name from request_secret (password_secret and/or key_secret); never pass the password or private key itself. The server host key is checked: the first successful connection saves its fingerprint, and a later mismatch is refused.',
      parameters: {
        host: { type: 'string', required: true, description: 'Server address (hostname or IP)' },
        port: { type: 'number', description: 'SSH port; default 22' },
        username: { type: 'string', required: true, description: 'Account name on the server' },
        password_secret: { type: 'string', description: 'Name of a saved secret holding the password (from request_secret or list_secrets)' },
        key_secret: { type: 'string', description: 'Name of a saved secret holding the private key' },
        passphrase_secret: { type: 'string', description: 'Name of a saved secret holding the private key passphrase, when the key is encrypted' },
      },
      output,
      async execute(args, exec) {
        const who = requireBot(exec, 'ssh_connect')
        if (who.error) return who.error
        const plain = rejectPlainAuth(args)
        if (plain) return plain
        const target = targetOrError(args)
        if (target.error) return target.error
        const key = connectionKey(who.botId, target)
        if (pool.get(key)?.client !== undefined) {
          const saved = known.get(target.hostId)
          return `Already connected to ${target.label}.${saved?.fingerprint ? ` Host key ${saved.fingerprint} matches the saved record.` : ''}`
        }
        const auth = await resolveAuth(rt, who.botId, args)
        if (auth.error) return auth.error
        try {
          const session = await connect(who.botId, target, auth)
          if (session.reused) return `Already connected to ${target.label}. Host key ${session.fingerprint ?? 'checked'} matches the saved record.`
          if (session.firstSeen) {
            return `Connected to ${target.label}. First time seeing this server; recorded host key ${session.fingerprint}. Later connections will require the same key.`
          }
          return `Connected to ${target.label}. Host key ${session.fingerprint} matches the saved record.`
        } catch (error) {
          return clean(error.message, auth)
        }
      },
    }),
    defineTool({
      name: 'ssh_exec',
      description: 'Run a command on a server already opened with ssh_connect (or open it now if secret names are given). Uses the existing connection when it is still up; a reconnect checks the saved host key again.',
      parameters: {
        host: { type: 'string', required: true, description: 'Server address used in ssh_connect' },
        port: { type: 'number', description: 'SSH port; default 22' },
        username: { type: 'string', required: true, description: 'Account name used in ssh_connect' },
        command: { type: 'string', required: true, description: 'Command to run on the server' },
        timeout_ms: { type: 'number', description: 'How long to wait, in milliseconds; default 60000' },
        password_secret: { type: 'string', description: 'Secret name for the password, only needed if not already connected' },
        key_secret: { type: 'string', description: 'Secret name for the private key, only needed if not already connected' },
        passphrase_secret: { type: 'string', description: 'Secret name for the key passphrase, only needed if not already connected' },
      },
      output,
      async execute(args, exec) {
        const who = requireBot(exec, 'ssh_exec')
        if (who.error) return who.error
        const command = String(args.command ?? '').trim()
        if (command === '') return 'Give a command to run on the server.'
        const timeoutMs = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0 ? args.timeout_ms : EXEC_TIMEOUT_MS
        const session = await getSession(who.botId, args)
        if (session.error) return session.error
        try {
          const result = await execCommand(session.client, command, timeoutMs, session.auth)
          return formatExec(session.target, result, command)
        } catch (error) {
          return clean(error.message, session.auth)
        }
      },
    }),
    defineTool({
      name: 'ssh_read',
      description: 'Read a text file on the remote server over the SSH connection opened with ssh_connect. For large or binary files, use ssh_download.',
      parameters: {
        host: { type: 'string', required: true, description: 'Server address used in ssh_connect' },
        port: { type: 'number', description: 'SSH port; default 22' },
        username: { type: 'string', required: true, description: 'Account name used in ssh_connect' },
        remote_path: { type: 'string', required: true, description: 'Absolute path of the file on the server' },
        password_secret: { type: 'string', description: 'Secret name for the password, only needed if not already connected' },
        key_secret: { type: 'string', description: 'Secret name for the private key, only needed if not already connected' },
        passphrase_secret: { type: 'string', description: 'Secret name for the key passphrase, only needed if not already connected' },
      },
      output,
      async execute(args, exec) {
        const who = requireBot(exec, 'ssh_read')
        if (who.error) return who.error
        const remotePath = String(args.remote_path ?? args.path ?? '').trim()
        if (remotePath === '') return 'Give the remote file path.'
        const session = await getSession(who.botId, args)
        if (session.error) return session.error
        try {
          return await withSftp(session.client, session.auth, async (sftp) => {
            try {
              const buf = await streamRead(sftp, remotePath)
              const text = asText(buf)
              if (text === undefined) return `The remote file ${remotePath} is binary (${buf.length} bytes). Use ssh_download to copy it locally.`
              return clean(text, session.auth)
            } catch (error) {
              if (error?.tooLarge) return `The remote file ${remotePath} is larger than ${READ_TEXT_MAX} bytes. Use ssh_download to copy it locally.`
              throw error
            }
          })
        } catch (error) {
          return clean(error.message, session.auth)
        }
      },
    }),
    defineTool({
      name: 'ssh_write',
      description: 'Write text to a file on the remote server over the SSH connection opened with ssh_connect. For local files, use ssh_upload.',
      parameters: {
        host: { type: 'string', required: true, description: 'Server address used in ssh_connect' },
        port: { type: 'number', description: 'SSH port; default 22' },
        username: { type: 'string', required: true, description: 'Account name used in ssh_connect' },
        remote_path: { type: 'string', required: true, description: 'Absolute path of the file on the server' },
        content: { type: 'string', required: true, description: 'Text to write to the remote file' },
        password_secret: { type: 'string', description: 'Secret name for the password, only needed if not already connected' },
        key_secret: { type: 'string', description: 'Secret name for the private key, only needed if not already connected' },
        passphrase_secret: { type: 'string', description: 'Secret name for the key passphrase, only needed if not already connected' },
      },
      output,
      async execute(args, exec) {
        const who = requireBot(exec, 'ssh_write')
        if (who.error) return who.error
        const remotePath = String(args.remote_path ?? args.path ?? '').trim()
        if (remotePath === '') return 'Give the remote file path.'
        if (typeof args.content !== 'string') return 'Give the text to write as content.'
        if (Buffer.byteLength(args.content, 'utf8') > WRITE_TEXT_MAX) {
          return `The text is larger than ${WRITE_TEXT_MAX} bytes. Save it locally and use ssh_upload.`
        }
        const session = await getSession(who.botId, args)
        if (session.error) return session.error
        try {
          await withSftp(session.client, session.auth, sftp => streamWrite(sftp, remotePath, args.content))
          return `Wrote ${remotePath} on ${session.target.label}.`
        } catch (error) {
          return clean(error.message, session.auth)
        }
      },
    }),
    defineTool({
      name: 'ssh_upload',
      description: 'Upload a local file to the remote server over the SSH connection opened with ssh_connect.',
      parameters: {
        host: { type: 'string', required: true, description: 'Server address used in ssh_connect' },
        port: { type: 'number', description: 'SSH port; default 22' },
        username: { type: 'string', required: true, description: 'Account name used in ssh_connect' },
        local_path: { type: 'string', required: true, description: 'Path of the local file to upload; a relative path starts in the working folder' },
        remote_path: { type: 'string', required: true, description: 'Destination path on the server' },
        password_secret: { type: 'string', description: 'Secret name for the password, only needed if not already connected' },
        key_secret: { type: 'string', description: 'Secret name for the private key, only needed if not already connected' },
        passphrase_secret: { type: 'string', description: 'Secret name for the key passphrase, only needed if not already connected' },
      },
      output,
      async execute(args, exec) {
        const who = requireBot(exec, 'ssh_upload')
        if (who.error) return who.error
        const remotePath = String(args.remote_path ?? '').trim()
        if (remotePath === '') return 'Give the remote destination path.'
        const session = await getSession(who.botId, args)
        if (session.error) return session.error
        try {
          const localPath = await localFrom(exec, args.local_path, { mustExist: true })
          await withSftp(session.client, session.auth, sftp => transfer(sftp, 'fastPut', localPath, remotePath, TRANSFER_TIMEOUT_MS, session.auth))
          return `Uploaded to ${remotePath} on ${session.target.label}.`
        } catch (error) {
          return clean(error.message, session.auth)
        }
      },
    }),
    defineTool({
      name: 'ssh_download',
      description: 'Download a file from the remote server to a local path over the SSH connection opened with ssh_connect.',
      parameters: {
        host: { type: 'string', required: true, description: 'Server address used in ssh_connect' },
        port: { type: 'number', description: 'SSH port; default 22' },
        username: { type: 'string', required: true, description: 'Account name used in ssh_connect' },
        remote_path: { type: 'string', required: true, description: 'Path of the file on the server' },
        local_path: { type: 'string', required: true, description: 'Local destination path; a relative path starts in the working folder' },
        password_secret: { type: 'string', description: 'Secret name for the password, only needed if not already connected' },
        key_secret: { type: 'string', description: 'Secret name for the private key, only needed if not already connected' },
        passphrase_secret: { type: 'string', description: 'Secret name for the key passphrase, only needed if not already connected' },
      },
      output,
      async execute(args, exec) {
        const who = requireBot(exec, 'ssh_download')
        if (who.error) return who.error
        const remotePath = String(args.remote_path ?? '').trim()
        if (remotePath === '') return 'Give the remote file path.'
        const session = await getSession(who.botId, args)
        if (session.error) return session.error
        try {
          const localPath = await localFrom(exec, args.local_path, { forWrite: true })
          await mkdir(dirname(localPath), { recursive: true })
          await withSftp(session.client, session.auth, sftp => transfer(sftp, 'fastGet', remotePath, localPath, TRANSFER_TIMEOUT_MS, session.auth))
          return `Downloaded ${remotePath} from ${session.target.label}.`
        } catch (error) {
          return clean(error.message, session.auth)
        }
      },
    }),
    defineTool({
      name: 'ssh_disconnect',
      description: 'Close an SSH connection opened with ssh_connect. Saved host keys and secrets are kept.',
      parameters: {
        host: { type: 'string', required: true, description: 'Server address used in ssh_connect' },
        port: { type: 'number', description: 'SSH port; default 22' },
        username: { type: 'string', required: true, description: 'Account name used in ssh_connect' },
      },
      output,
      async execute(args, exec) {
        const who = requireBot(exec, 'ssh_disconnect')
        if (who.error) return who.error
        const target = targetOrError(args)
        if (target.error) return target.error
        const key = connectionKey(who.botId, target)
        if (pool.get(key) === undefined) return `No open connection to ${target.label}.`
        drop(key)
        return `Disconnected from ${target.label}.`
      },
    }),
  ]

  if (typeof rt.ctx?.effect === 'function') {
    rt.ctx.effect(() => () => closeAll(), 'ds-bot: ssh connections')
  }

  return { tools, closeAll, knownHostsPath: knownPath, pool, loadKnown, known }
}

export function install(rt) {
  const api = attachSsh(rt)
  // Same pattern as the other modules: push now, then index.js calls syncScopedTools
  // once every module has added its tools.
  rt.teamTools.push(...api.tools)
  Object.assign(rt, { sshCloseAll: api.closeAll, sshKnownHostsPath: api.knownHostsPath })
}
