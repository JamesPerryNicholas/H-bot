// Run against the archive with Electron's module loader, outside the checkout, so
// development dependencies cannot hide a missing package in the installer.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { extractFile } from '@electron/asar'

const directory = resolve(process.argv[2] ?? 'dist-pack/win-unpacked')
const archive = join(directory, 'resources', 'app.asar')
const manifest = JSON.parse(extractFile(archive, 'package.json').toString())
const executable = join(directory, `${manifest.productName}.exe`)

async function check(archive) {
  const assert = require('node:assert/strict')
  const { existsSync } = require('node:fs')
  const { createRequire } = require('node:module')
  const { join, relative, isAbsolute } = require('node:path')
  const { pathToFileURL } = require('node:url')
  const plugin = join(archive, 'node_modules', 'ds-bot', 'package.json')
  const pluginRequire = createRequire(plugin)
  const expected = pluginRequire(plugin).dependencies.ssh2
  assert.ok(expected, 'the plugin must declare ssh2')
  const seen = new Set()
  function visit(name, from) {
    const file = from.resolve(`${name}/package.json`)
    const inside = relative(archive, file)
    assert.ok(!isAbsolute(inside) && !inside.startsWith('..'), `${name} resolved outside app.asar`)
    if (seen.has(file)) return
    seen.add(file)
    const metadata = from(file)
    const here = createRequire(file)
    if (name === 'ssh2') assert.equal(metadata.version, expected)
    for (const dependency of Object.keys(metadata.dependencies ?? {})) visit(dependency, here)
    console.log(`packed SSH dependency: ${metadata.name}@${metadata.version}`)
  }
  visit('ssh2', pluginRequire)
  assert.equal(typeof pluginRequire('ssh2').Client, 'function')
  const ssh = await import(pathToFileURL(join(archive, 'node_modules', 'ds-bot', 'src', 'host', 'ssh.js')).href)
  assert.equal(typeof ssh.install, 'function')
  for (const file of ['bundled-credit-envelope.json', 'bundled-credit-open-wrap.json']) {
    assert.equal(existsSync(join(archive, 'src', file)), false, `${file} must not be bundled`)
  }
  console.log('packed SSH import and dependency tree passed; no bundled credit envelopes')
}

const work = mkdtempSync(join(tmpdir(), 'h-bot-ssh-check-'))
try {
  const result = spawnSync(executable, ['-e', `(${check.toString()})(${JSON.stringify(archive)}).catch(error => { console.error(error); process.exitCode = 1 })`], {
    cwd: work,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error || result.status !== 0 || !result.stdout?.includes('packed SSH import and dependency tree passed')) {
    throw new Error(`Packaged SSH check failed: ${result.error?.message ?? `exit ${result.status}`}`)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}
