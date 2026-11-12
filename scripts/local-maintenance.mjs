// Local source snapshots and verification. This command never installs or restarts the app.
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoots = ['app', 'ds-bot', 'scripts']
const ignoredDirectories = new Set(['node_modules', '.git', '.tools', '.ds-bot-local', '.h-bot-maintenance', 'dist', 'dist-pack', 'dist-next', 'build', 'shots', 'out'])
const rootFiles = ['AGENTS.md', '.gitignore', 'maintain.ps1', 'maintenance.config.json', 'start.ps1', 'dev.ps1', 'build-exe.ps1', 'docs/local-maintenance.md']
const privateFile = name => name.startsWith('.env') || /^(?:\.credentials|credentials|mail_config|secrets)(?:\.|$)/i.test(name)

export function inside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export async function loadConfig(root) {
  const config = JSON.parse(await readFile(join(root, 'maintenance.config.json'), 'utf8'))
  if (config.schemaVersion !== 1) throw new Error('Unsupported maintenance config version')
  if (!/^\d+\.\d+\.\d+$/.test(config.minimumNode)) throw new Error('Invalid minimumNode')
  if (typeof config.outputDir !== 'string' || !inside(root, resolve(root, config.outputDir))) throw new Error('outputDir must be inside the source directory')
  if (!Number.isSafeInteger(config.checkTimeoutMs) || config.checkTimeoutMs < 1000 || config.checkTimeoutMs > 1800000) throw new Error('Invalid checkTimeoutMs')
  if (!Array.isArray(config.checks) || config.checks.length === 0 || new Set(config.checks).size !== config.checks.length) throw new Error('checks must be a nonempty list without duplicates')
  return config
}

export function supportedNode(actual, minimum) {
  const a = actual.split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

export async function sourceFiles(root, outputDir) {
  const result = []
  const walk = async rel => {
    const file = join(root, rel)
    if (resolve(file) === resolve(outputDir)) return
    let stat
    try { stat = await lstat(file) } catch (error) {
      if (error.code === 'ENOENT' && rootFiles.includes(rel)) return
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`Source snapshot refuses a link: ${rel}`)
    if (stat.isDirectory()) {
      for (const entry of await readdir(file, { withFileTypes: true })) {
        if (ignoredDirectories.has(entry.name) || entry.name.startsWith('.dsh-') || privateFile(entry.name)) continue
        await walk(join(rel, entry.name))
      }
    } else if (stat.isFile() && !privateFile(rel.split(sep).at(-1))) {
      result.push(rel)
    }
  }
  for (const rel of [...rootFiles, ...sourceRoots]) await walk(rel)
  return result.sort()
}

export async function createSnapshot(root, destination, files) {
  await mkdir(destination, { recursive: true })
  const manifest = []
  for (const rel of files) {
    if (!inside(root, join(root, rel)) || !inside(destination, join(destination, rel))) throw new Error(`Invalid snapshot path: ${rel}`)
    const target = join(destination, rel)
    await mkdir(dirname(target), { recursive: true })
    const bytes = await readFile(join(root, rel))
    await writeFile(target, bytes, { flag: 'wx' })
    manifest.push({ path: rel.split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  return manifest
}

export async function changedSources(root, outputDir, manifest) {
  const before = new Map(manifest.map(entry => [entry.path, entry.sha256]))
  const changed = []
  for (const rel of await sourceFiles(root, outputDir)) {
    const key = rel.split(sep).join('/')
    const hash = createHash('sha256').update(await readFile(join(root, rel))).digest('hex')
    if (before.get(key) !== hash) changed.push(key)
    before.delete(key)
  }
  return [...changed, ...before.keys()]
}

export function checkDefinitions(root) {
  return {
    'maintenance-tests': { cwd: root, args: ['--test', 'scripts/local-maintenance.test.mjs'] },
    'desktop-tests': { cwd: join(root, 'app'), args: ['--test', 'test/*.test.mjs'] },
    'plugin-build-check': { cwd: join(root, 'ds-bot'), args: ['scripts/build-client.mjs', '--check'] },
    'plugin-lint': { cwd: join(root, 'ds-bot'), args: ['scripts/lint.mjs'] },
    'plugin-tests': { cwd: join(root, 'ds-bot'), args: ['--import', './test/harness-resolve.mjs', '--test', '--test-timeout=120000', '--test-force-exit', 'test/*.test.js'] },
  }
}

export async function runCheck(name, definition, logPath, timeoutMs) {
  const log = createWriteStream(logPath, { flags: 'wx' })
  await new Promise((done, fail) => { log.once('open', done); log.once('error', fail) })
  const started = Date.now()
  let timedOut = false
  let spawnError
  const checkEnv = { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` }
  // A test runner's child marker makes a new `node --test` skip all files and exit zero.
  delete checkEnv.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, definition.args, {
    cwd: definition.cwd,
    env: checkEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => child.kill())
      killer.on('exit', code => { if (code !== 0) child.kill() })
    } else child.kill('SIGKILL')
  }, timeoutMs)
  const result = await new Promise(done => {
    child.once('error', error => { spawnError = error.message })
    child.once('close', (code, signal) => done({ code, signal }))
  })
  clearTimeout(timer)
  await new Promise((done, fail) => { log.once('error', fail); log.end(done) })
  return { name, ...result, timedOut, ...(spawnError ? { error: spawnError } : {}), passed: result.code === 0 && !timedOut && !spawnError, durationMs: Date.now() - started, log: logPath }
}

export async function maintain(root, action = 'check') {
  if (!['check', 'snapshot'].includes(action)) throw new Error('Usage: maintain.ps1 [check|snapshot]')
  const config = await loadConfig(root)
  if (!supportedNode(process.versions.node, config.minimumNode)) throw new Error(`Node ${config.minimumNode}+ is required; use maintain.ps1 to select the project Node`)
  const definitions = checkDefinitions(root)
  for (const name of config.checks) if (!Object.hasOwn(definitions, name)) throw new Error(`Unknown check: ${name}`)
  const outputDir = resolve(root, config.outputDir)
  await mkdir(outputDir, { recursive: true })
  // Resolve links before writing: output must stay in this source tree.
  const { realpath } = await import('node:fs/promises')
  if (!inside(await realpath(root), await realpath(outputDir))) throw new Error('outputDir resolves outside the source directory')
  const lockPath = join(outputDir, 'running.lock')
  let lock
  try { lock = await open(lockPath, 'wx') } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another maintenance run may be active; inspect ${lockPath}`)
    throw error
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    const runDir = join(outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
    const snapshot = join(runDir, 'source')
    const files = await sourceFiles(root, outputDir)
    const manifest = await createSnapshot(root, snapshot, files)
    const report = { startedAt: new Date().toISOString(), action, source: root, node: process.versions.node, snapshot, fileCount: manifest.length, checks: [], notRun: [], passed: true }
    console.log(`H bot: source snapshot saved (${manifest.length} files): ${snapshot}`)
    try {
      for (const name of action === 'check' ? config.checks : []) {
        console.log(`H bot: checking ${name}`)
        const result = await runCheck(name, definitions[name], join(runDir, `${name}.log`), config.checkTimeoutMs)
        report.checks.push(result)
        console.log(`H bot: ${name}: ${result.passed ? 'passed' : 'FAILED'} (${result.log})`)
        if (!result.passed) {
          report.passed = false
          report.notRun = config.checks.slice(report.checks.length)
          break
        }
      }
      report.changedDuringRun = await changedSources(root, outputDir, manifest)
      if (report.changedDuringRun.length > 0) {
        report.passed = false
        console.error('H bot: source changed during verification; run the checks again after edits finish')
      }
    } catch (error) {
      report.passed = false
      report.error = error.message
      report.notRun = config.checks.slice(report.checks.length)
    }
    // Snapshot-only runs never replace the last verification result.
    report.finishedAt = new Date().toISOString()
    const reportText = `${JSON.stringify(report, null, 2)}\n`
    await writeFile(join(runDir, 'report.json'), reportText, { flag: 'wx' })
    if (action === 'check') {
      const pending = join(outputDir, 'last-report.pending.json')
      await writeFile(pending, reportText)
      const { rename } = await import('node:fs/promises')
      await rename(pending, join(outputDir, 'last-report.json'))
    }
    console.log(`H bot: report: ${join(runDir, 'report.json')}`)
    return report
  } finally {
    await lock.close()
    await unlink(lockPath)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    const report = await maintain(root, process.argv[2] ?? 'check')
    if (!report.passed) process.exitCode = 1
  } catch (error) {
    console.error(`H bot maintenance: ${error.message}`)
    process.exitCode = 1
  }
}
