import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TEAM_TOOLS } from '../src/host/constants.js'
import {
  attachSsh,
  connectionKey,
  DEFAULT_PORT,
  fingerprintOf,
  hostIdOf,
  KNOWN_HOSTS_FILE,
  parseTarget,
  rejectPlainAuth,
  resolveAuth,
  sanitizeText,
  SSH_TOOLS,
} from '../src/host/ssh.js'

const HOST_KEY_A = Buffer.from('ssh-host-key-alpha')
const HOST_KEY_B = Buffer.from('ssh-host-key-bravo')
const FINGERPRINT_A = fingerprintOf(HOST_KEY_A)
const FINGERPRINT_B = fingerprintOf(HOST_KEY_B)

function createFakeSsh({
  hostKey = HOST_KEY_A,
  execHandler,
  files = new Map(),
  failConnect,
} = {}) {
  const stats = { connects: 0, hostChecks: 0, execs: 0, lastConnect: undefined }
  class FakeClient extends EventEmitter {
    connect(cfg) {
      stats.connects += 1
      stats.lastConnect = cfg
      queueMicrotask(() => {
        if (typeof cfg.hostVerifier !== 'function') {
          this.emit('error', new Error('missing hostVerifier'))
          return
        }
        stats.hostChecks += 1
        const finish = (ok) => {
          if (!ok) {
            this.emit('error', Object.assign(new Error('Host key verification failed'), { level: 'handshake' }))
            return
          }
          if (typeof failConnect === 'function') {
            const err = failConnect(cfg)
            if (err) { this.emit('error', err); return }
          }
          this.ready = true
          this.emit('ready')
        }
        const ret = cfg.hostVerifier(hostKey, finish)
        if (ret !== undefined && typeof ret !== 'function' && !ret?.then) finish(Boolean(ret))
      })
    }
    exec(command, cb) {
      stats.execs += 1
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      queueMicrotask(() => {
        const result = execHandler ? execHandler(command, stats.lastConnect) : { stdout: `ran:${command}`, code: 0 }
        if (result.error) {
          cb(result.error)
          return
        }
        cb(null, stream)
        if (result.stdout) stream.emit('data', Buffer.from(result.stdout))
        if (result.stderr) stream.stderr.emit('data', Buffer.from(result.stderr))
        stream.emit('close', result.code ?? 0, result.signal ?? null)
      })
    }
    sftp(cb) {
      const sftp = {
        createReadStream(remotePath) {
          const stream = new EventEmitter()
          queueMicrotask(() => {
            if (!files.has(remotePath)) {
              stream.emit('error', new Error(`no such file ${remotePath}`))
              return
            }
            const value = files.get(remotePath)
            stream.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value))
            stream.emit('end')
          })
          stream.destroy = () => {}
          return stream
        },
        createWriteStream(remotePath) {
          const stream = new EventEmitter()
          const chunks = []
          stream.end = (data) => {
            if (data !== undefined) chunks.push(Buffer.from(data))
            files.set(remotePath, Buffer.concat(chunks))
            queueMicrotask(() => stream.emit('close'))
          }
          stream.write = (data) => { chunks.push(Buffer.from(data)); return true }
          return stream
        },
        fastPut(localPath, remotePath, done) {
          try {
            files.set(remotePath, readFileSync(localPath))
            done()
          } catch (error) { done(error) }
        },
        fastGet(remotePath, localPath, done) {
          try {
            if (!files.has(remotePath)) throw new Error(`no such file ${remotePath}`)
            writeFileSync(localPath, files.get(remotePath))
            done()
          } catch (error) { done(error) }
        },
      }
      queueMicrotask(() => cb(null, sftp))
    }
    end() {
      this.ready = false
      this.emit('end')
      this.emit('close')
    }
  }
  return { FakeClient, stats, files }
}

function fakeRt({ home, secrets = {}, botId = 'b1', canUse, readOnly } = {}) {
  const values = new Map(Object.entries(secrets))
  const redact = (text) => {
    let out = String(text ?? '')
    for (const [name, value] of values) {
      if (typeof value === 'string' && value.length >= 4 && out.includes(value)) out = out.split(value).join(`[secret:${name}]`)
    }
    return out
  }
  const disposers = []
  return {
    home,
    teamTools: [],
    addTeamTool(def) { this.teamTools.push(def) },
    botOf: id => (id === botId ? { id, name: 'Coder' } : undefined),
    selfOf: id => id,
    loadSecrets: async () => {},
    secretValue: name => values.get(name),
    canUseSecret: (name, id) => values.has(name) && (canUse ? canUse(name, id) : id === botId),
    redactSecrets: redact,
    readOnly: () => readOnly,
    warn: () => {},
    ctx: { effect: (fn) => { disposers.push(fn() ?? (() => {})) } },
    sessionFolder: () => home,
    workDirOf: () => home,
    teamFolder: () => home,
    inData: async (path) => String(path).includes('secrets.json') || String(path).includes(KNOWN_HOSTS_FILE),
    realBeyond: async path => path,
    _disposers: disposers,
    _values: values,
  }
}

const execFor = (rt, agentId = 'b1') => ({ agent: { id: agentId, session: { header: { id: agentId } } }, callId: 'c1' })
const tool = (rt, name) => rt.teamTools.find(def => def.name === name)
const call = (rt, name, args, agentId) => tool(rt, name).execute(args, execFor(rt, agentId))

function start(opts = {}) {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'ds-bot-ssh-'))
  const fake = createFakeSsh(opts.ssh ?? {})
  const rt = fakeRt({ home, secrets: opts.secrets, botId: opts.botId, canUse: opts.canUse, readOnly: opts.readOnly })
  const api = attachSsh(rt, { Client: fake.FakeClient })
  for (const def of api.tools) rt.addTeamTool(def)
  const stop = () => {
    api.closeAll()
    for (const dispose of rt._disposers) { try { dispose() } catch {} }
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { home, rt, api, fake, stop }
}

test('TEAM_TOOLS lists every SSH tool', () => {
  for (const name of SSH_TOOLS) assert.ok(TEAM_TOOLS.includes(name), name)
})

test('parseTarget defaults the port to 22 and requires host and username', () => {
  assert.deepEqual(parseTarget({ host: 'Example.COM', username: 'deploy' }), {
    host: 'example.com',
    port: 22,
    username: 'deploy',
    label: 'deploy@example.com:22',
    hostId: 'example.com:22',
  })
  assert.equal(parseTarget({ host: 'x' }).error.includes('username'), true)
  assert.equal(parseTarget({ username: 'x' }).error.includes('host'), true)
  assert.equal(parseTarget({ host: 'x', username: 'y', port: 0 }).error.includes('Port'), true)
  assert.equal(DEFAULT_PORT, 22)
  assert.equal(hostIdOf('EX.com', 2222), 'ex.com:2222')
  assert.equal(connectionKey('b1', { username: 'u', host: 'h', port: 22 }), 'b1::u@h:22')
})

test('plain password or key arguments are rejected', () => {
  assert.match(rejectPlainAuth({ password: 'secret-pass' }), /request_secret/)
  assert.match(rejectPlainAuth({ privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----' }), /request_secret/)
  assert.equal(rejectPlainAuth({ password_secret: 'SSH_PASSWORD' }), undefined)
})

test('resolveAuth reads secrets from the local store and never requires the raw value as an argument', async () => {
  const password = 'super-password-value'
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-material-zzzz\n-----END OPENSSH PRIVATE KEY-----'
  const rt = fakeRt({ home: mkdtempSync(join(tmpdir(), 'ds-bot-ssh-auth-')), secrets: { SSH_PASSWORD: password, SSH_KEY: key }, botId: 'b1' })
  const missing = await resolveAuth(rt, 'b1', { host: 'h' })
  assert.match(missing.error, /password_secret|key_secret|request_secret/)
  const denied = await resolveAuth(rt, 'other', { password_secret: 'SSH_PASSWORD' })
  assert.match(denied.error, /may not use SSH_PASSWORD/)
  const absent = await resolveAuth(rt, 'b1', { password_secret: 'NO_SUCH' })
  assert.match(absent.error, /not saved yet/)
  const ok = await resolveAuth(rt, 'b1', { password_secret: 'ssh-password', key_secret: 'SSH_KEY' })
  assert.equal(ok.passwordName, 'SSH_PASSWORD')
  assert.equal(ok.password, password)
  assert.equal(ok.keyName, 'SSH_KEY')
  assert.equal(ok.privateKey, key)
  assert.match((await resolveAuth(rt, 'b1', { password })).error, /Do not pass/)
})

test('sanitizeText strips passwords, keys, and PEM blocks', () => {
  const password = 'super-password-value'
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-material-zzzz\n-----END OPENSSH PRIVATE KEY-----'
  const redact = text => text.replaceAll(password, '[secret:SSH_PASSWORD]')
  assert.equal(sanitizeText(`auth failed: ${password}`, [password], redact), 'auth failed: [secret:SSH_PASSWORD]')
  assert.equal(sanitizeText(`bad key ${pem}`, [], text => text), 'bad key [secret]')
})

test('ssh_connect records the host fingerprint on first use and reuses the live connection', async (t) => {
  const password = 'super-password-value'
  const bench = start({ secrets: { SSH_PASSWORD: password } })
  t.after(bench.stop)
  const args = { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' }
  const first = await call(bench.rt, 'ssh_connect', args)
  assert.match(first, /First time seeing this server/)
  assert.ok(first.includes(FINGERPRINT_A), first)
  assert.ok(!first.includes(password))
  const saved = JSON.parse(readFileSync(join(bench.home, KNOWN_HOSTS_FILE), 'utf8'))
  assert.equal(saved.hosts[0].host, 'lab.example')
  assert.equal(saved.hosts[0].port, 22)
  assert.equal(saved.hosts[0].fingerprint, FINGERPRINT_A)
  assert.equal(bench.fake.stats.connects, 1)
  assert.equal(bench.fake.stats.hostChecks, 1)
  assert.equal(bench.fake.stats.lastConnect.password, password)
  assert.equal(bench.fake.stats.lastConnect.port, 22)

  const again = await call(bench.rt, 'ssh_connect', args)
  assert.match(again, /Already connected/)
  assert.ok(!again.includes(password))
  assert.equal(bench.fake.stats.connects, 1)
  assert.equal(bench.fake.stats.hostChecks, 1)
})

test('a later host key mismatch is refused and the saved fingerprint is left unchanged', async (t) => {
  const password = 'super-password-value'
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-ssh-mm-'))
  const first = start({ home, secrets: { SSH_PASSWORD: password }, ssh: { hostKey: HOST_KEY_A } })
  const args = { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' }
  const ok = await call(first.rt, 'ssh_connect', args)
  assert.match(ok, /First time/)
  first.api.closeAll()
  // Keep the home; only close the first runtime.
  first.api.closeAll()
  const second = start({ home, secrets: { SSH_PASSWORD: password }, ssh: { hostKey: HOST_KEY_B } })
  t.after(() => { second.stop() })
  const refused = await call(second.rt, 'ssh_connect', args)
  assert.match(refused, /does not match the one saved earlier/)
  assert.ok(!refused.includes(password))
  assert.ok(!refused.includes(FINGERPRINT_B) || refused.includes('does not match'))
  const saved = JSON.parse(readFileSync(join(home, KNOWN_HOSTS_FILE), 'utf8'))
  assert.equal(saved.hosts[0].fingerprint, FINGERPRINT_A)
  assert.equal(second.fake.stats.connects, 1)
  assert.equal(second.fake.stats.hostChecks, 1)
})

test('the matching saved host key is accepted on a new connection, and the check is not skipped', async (t) => {
  const password = 'super-password-value'
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-ssh-ok-'))
  const first = start({ home, secrets: { SSH_PASSWORD: password }, ssh: { hostKey: HOST_KEY_A } })
  const args = { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' }
  await call(first.rt, 'ssh_connect', args)
  await call(first.rt, 'ssh_disconnect', { host: 'lab.example', username: 'deploy' })
  first.api.closeAll()
  const second = start({ home, secrets: { SSH_PASSWORD: password }, ssh: { hostKey: HOST_KEY_A } })
  t.after(() => second.stop())
  const text = await call(second.rt, 'ssh_connect', args)
  assert.match(text, /matches the saved record/)
  assert.ok(!text.includes(password))
  assert.equal(second.fake.stats.connects, 1)
  assert.equal(second.fake.stats.hostChecks, 1)
})

test('ssh_exec reuses the connection and keeps the password out of the result, even when the server echoes it', async (t) => {
  const password = 'super-password-value'
  const bench = start({
    secrets: { SSH_PASSWORD: password },
    ssh: {
      execHandler(command) {
        return { stdout: `out ${command} pw=${password}`, stderr: `err ${password}`, code: 0 }
      },
    },
  })
  t.after(bench.stop)
  const args = { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' }
  await call(bench.rt, 'ssh_connect', args)
  const text = await call(bench.rt, 'ssh_exec', { ...args, command: 'uname -a' })
  assert.match(text, /Ran on deploy@lab.example:22/)
  assert.match(text, /uname -a/)
  assert.match(text, /\[secret:SSH_PASSWORD\]/)
  assert.ok(!text.includes(password))
  assert.equal(bench.fake.stats.connects, 1)
  assert.equal(bench.fake.stats.execs, 1)

  const again = await call(bench.rt, 'ssh_exec', { host: 'lab.example', username: 'deploy', command: 'pwd' })
  assert.match(again, /pwd/)
  assert.ok(!again.includes(password))
  assert.equal(bench.fake.stats.connects, 1)
  assert.equal(bench.fake.stats.execs, 2)
})

test('a connect error that mentions the password is redacted', async (t) => {
  const password = 'super-password-value'
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-material-zzzz\n-----END OPENSSH PRIVATE KEY-----'
  const bench = start({
    secrets: { SSH_PASSWORD: password, SSH_KEY: key },
    ssh: {
      failConnect(cfg) {
        return new Error(`Authentication failed for password=${cfg.password} key=${cfg.privateKey}`)
      },
    },
  })
  t.after(bench.stop)
  const text = await call(bench.rt, 'ssh_connect', {
    host: 'lab.example',
    username: 'deploy',
    password_secret: 'SSH_PASSWORD',
    key_secret: 'SSH_KEY',
  })
  assert.match(text, /Authentication failed/)
  assert.ok(!text.includes(password))
  assert.ok(!text.includes('fake-key-material-zzzz'))
  assert.ok(!text.includes(key))
})

test('ssh_read, ssh_write, ssh_upload and ssh_download move file contents over the open connection', async (t) => {
  const password = 'super-password-value'
  const remote = new Map([['/var/app/notes.txt', Buffer.from('hello remote')]])
  const bench = start({ secrets: { SSH_PASSWORD: password }, ssh: { files: remote } })
  t.after(bench.stop)
  const conn = { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' }
  await call(bench.rt, 'ssh_connect', conn)

  const read = await call(bench.rt, 'ssh_read', { ...conn, remote_path: '/var/app/notes.txt' })
  assert.equal(read, 'hello remote')
  assert.ok(!read.includes(password))

  const wrote = await call(bench.rt, 'ssh_write', { ...conn, remote_path: '/var/app/notes.txt', content: 'updated' })
  assert.match(wrote, /Wrote \/var\/app\/notes.txt/)
  assert.equal(remote.get('/var/app/notes.txt').toString(), 'updated')

  const localUpload = join(bench.home, 'workspace', 'upload.txt')
  mkdirSync(join(bench.home, 'workspace'), { recursive: true })
  writeFileSync(localUpload, 'from-local')
  const uploaded = await call(bench.rt, 'ssh_upload', { ...conn, local_path: localUpload, remote_path: '/var/app/upload.txt' })
  assert.match(uploaded, /Uploaded/)
  assert.equal(remote.get('/var/app/upload.txt').toString(), 'from-local')

  const localDownload = join(bench.home, 'workspace', 'down', 'got.txt')
  const downloaded = await call(bench.rt, 'ssh_download', { ...conn, remote_path: '/var/app/upload.txt', local_path: localDownload })
  assert.match(downloaded, /Downloaded/)
  assert.equal(readFileSync(localDownload, 'utf8'), 'from-local')
  assert.equal(bench.fake.stats.connects, 1)
})

test('ssh_exec after a drop reconnects and checks the host key again', async (t) => {
  const password = 'super-password-value'
  const bench = start({ secrets: { SSH_PASSWORD: password } })
  t.after(bench.stop)
  const args = { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' }
  await call(bench.rt, 'ssh_connect', args)
  await call(bench.rt, 'ssh_disconnect', { host: 'lab.example', username: 'deploy' })
  const text = await call(bench.rt, 'ssh_exec', { host: 'lab.example', username: 'deploy', command: 'id' })
  assert.match(text, /Ran on deploy@lab.example:22: id/)
  assert.ok(!text.includes(password))
  assert.equal(bench.fake.stats.connects, 2)
  assert.equal(bench.fake.stats.hostChecks, 2)
})

test('upload refuses a local path inside the team secrets file', async (t) => {
  const password = 'super-password-value'
  const bench = start({ secrets: { SSH_PASSWORD: password } })
  t.after(bench.stop)
  await call(bench.rt, 'ssh_connect', { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' })
  const text = await call(bench.rt, 'ssh_upload', {
    host: 'lab.example',
    username: 'deploy',
    local_path: join(bench.home, 'secrets.json'),
    remote_path: '/tmp/out',
  })
  assert.match(text, /H bot data/)
  assert.ok(!text.includes(password))
})


test('ssh_connect accepts a saved private key and passphrase, and keeps key material out of the result', async (t) => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-material-zzzz\n-----END OPENSSH PRIVATE KEY-----'
  const passphrase = 'key-passphrase-value'
  const bench = start({ secrets: { SSH_KEY: key, SSH_KEY_PASS: passphrase } })
  t.after(bench.stop)
  const text = await call(bench.rt, 'ssh_connect', {
    host: 'lab.example',
    username: 'deploy',
    key_secret: 'SSH_KEY',
    passphrase_secret: 'SSH_KEY_PASS',
  })
  assert.match(text, /First time seeing this server/)
  assert.ok(!text.includes(key))
  assert.ok(!text.includes('fake-key-material-zzzz'))
  assert.ok(!text.includes(passphrase))
  assert.equal(bench.fake.stats.lastConnect.port, 22)
  assert.equal(bench.fake.stats.lastConnect.password, undefined)
  assert.equal(bench.fake.stats.lastConnect.privateKey, key)
  assert.equal(bench.fake.stats.lastConnect.passphrase, passphrase)
  assert.equal(bench.fake.stats.connects, 1)
  assert.equal(bench.fake.stats.hostChecks, 1)
})

test('ssh_connect and ssh_exec reject plaintext password or key arguments, including on a live connection', async (t) => {
  const password = 'super-password-value'
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-material-zzzz\n-----END OPENSSH PRIVATE KEY-----'
  const bench = start({ secrets: { SSH_PASSWORD: password, SSH_KEY: key } })
  t.after(bench.stop)
  for (const field of ['password', 'private_key', 'privateKey', 'passphrase', 'key', 'identity']) {
    const value = ['private_key', 'privateKey', 'key', 'identity'].includes(field) ? key : password
    const text = await call(bench.rt, 'ssh_connect', {
      host: 'lab.example',
      username: 'deploy',
      password_secret: 'SSH_PASSWORD',
      [field]: value,
    })
    assert.match(text, /Do not pass a password or private key/, field)
    assert.ok(!text.includes(password), field)
    assert.ok(!text.includes(key), field)
    assert.ok(!text.includes('fake-key-material-zzzz'), field)
  }
  assert.equal(bench.fake.stats.connects, 0)

  const connected = await call(bench.rt, 'ssh_connect', {
    host: 'lab.example',
    username: 'deploy',
    password_secret: 'SSH_PASSWORD',
  })
  assert.match(connected, /Connected/)
  assert.equal(bench.fake.stats.connects, 1)

  const again = await call(bench.rt, 'ssh_connect', {
    host: 'lab.example',
    username: 'deploy',
    password: password,
  })
  assert.match(again, /Do not pass a password or private key/)
  assert.ok(!again.includes(password))

  const execText = await call(bench.rt, 'ssh_exec', {
    host: 'lab.example',
    username: 'deploy',
    command: 'id',
    password,
  })
  assert.match(execText, /Do not pass a password or private key/)
  assert.ok(!execText.includes(password))
  assert.equal(bench.fake.stats.execs, 0)
  assert.equal(bench.fake.stats.connects, 1)
})

test('ssh_read redacts a password or private key found in the remote file', async (t) => {
  const password = 'super-password-value'
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-material-zzzz\n-----END OPENSSH PRIVATE KEY-----'
  const remote = new Map([['/var/app/leak.txt', Buffer.from(`pw=${password}\n${key}\n`)]])
  const bench = start({ secrets: { SSH_PASSWORD: password, SSH_KEY: key }, ssh: { files: remote } })
  t.after(bench.stop)
  await call(bench.rt, 'ssh_connect', { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' })
  const text = await call(bench.rt, 'ssh_read', {
    host: 'lab.example',
    username: 'deploy',
    remote_path: '/var/app/leak.txt',
  })
  assert.ok(!text.includes(password), text)
  assert.ok(!text.includes(key), text)
  assert.ok(!text.includes('fake-key-material-zzzz'), text)
  assert.match(text, /\[secret/)
})

test('ssh_download refuses a local path inside the team secrets or known-hosts file', async (t) => {
  const password = 'super-password-value'
  const remote = new Map([['/var/app/out.txt', Buffer.from('payload')]])
  const bench = start({ secrets: { SSH_PASSWORD: password }, ssh: { files: remote } })
  t.after(bench.stop)
  await call(bench.rt, 'ssh_connect', { host: 'lab.example', username: 'deploy', password_secret: 'SSH_PASSWORD' })
  const beforeHosts = readFileSync(join(bench.home, KNOWN_HOSTS_FILE), 'utf8')
  for (const name of ['secrets.json', KNOWN_HOSTS_FILE]) {
    const dest = join(bench.home, name)
    const text = await call(bench.rt, 'ssh_download', {
      host: 'lab.example',
      username: 'deploy',
      remote_path: '/var/app/out.txt',
      local_path: dest,
    })
    assert.match(text, /H bot data/, name)
    assert.ok(!text.includes(password), name)
    let body = ''
    try { body = readFileSync(dest, 'utf8') } catch { body = '' }
    assert.ok(!body.includes('payload'), name)
  }
  assert.equal(readFileSync(join(bench.home, KNOWN_HOSTS_FILE), 'utf8'), beforeHosts)
})
