import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const config = name => parse(readFileSync(new URL(`../electron-builder.${name}.yml`, import.meta.url), 'utf8'))

test('the open installer upgrades the existing H bot identity and keeps its data locations', () => {
  const open = config('open')
  const local = config('local')
  assert.equal(open.appId, local.appId)
  assert.equal(open.productName, local.productName)
  assert.equal(open.nsis.guid, local.nsis.guid)
  assert.equal(open.extraMetadata.name, local.extraMetadata.name)
  assert.equal(open.extraMetadata.productName, local.extraMetadata.productName)
  assert.deepEqual(open.extraMetadata.dsBotBuild.identity, local.extraMetadata.dsBotBuild.identity)
  assert.deepEqual(open.extraMetadata.dsBotBuild.defaultPlaces, local.extraMetadata.dsBotBuild.defaultPlaces)
  assert.equal(open.extraMetadata.dsBotBuild.creditVariant, 'open')
  assert.equal(open.nsis.deleteAppDataOnUninstall, false)
})

test('release manifests and lock entries agree on the application version', () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
  for (const directory of ['app', 'ds-bot']) {
    const root = new URL(`../../${directory}/`, import.meta.url)
    assert.equal(JSON.parse(readFileSync(new URL('package.json', root))).version, version)
    const lock = JSON.parse(readFileSync(new URL('package-lock.json', root)))
    assert.equal(lock.version, version)
    assert.equal(lock.packages[''].version, version)
  }
  const appLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)))
  assert.equal(appLock.packages['node_modules/ds-bot'].version, version)
})

function makensis() {
  const cache = process.env.ELECTRON_BUILDER_CACHE ?? join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')
  if (!existsSync(cache)) return undefined
  for (const name of readdirSync(cache).filter(name => name.startsWith('nsis'))) {
    const root = join(cache, name)
    if (!existsSync(root) || !readdirSync(root).length) continue
    for (const child of ['', ...readdirSync(root)]) {
      const file = join(root, child, 'Bin', 'makensis.exe')
      if (existsSync(file)) return file
    }
  }
}

test('NSIS detects custom existing folders, fixes stale registration, and leaves unrelated editions alone', { skip: process.platform !== 'win32' }, t => {
  const compiler = makensis()
  if (!compiler) { t.skip('NSIS compiler is not cached'); return }
  const work = mkdtempSync(join(tmpdir(), 'h-bot-installer-test-'))
  // These random registry keys and fake executables are isolated from real installations/data.
  const registry = `Software\\HBotInstallerTests\\${work.split(/[\\/]/u).at(-1)}`
  const current = join(work, 'custom existing folder')
  const stale = join(work, 'old folder')
  writeFileSync(join(work, 'result.ini'), '\ufeff', 'utf16le')
  for (const directory of [current, stale]) {
    mkdirSync(directory)
    writeFileSync(join(directory, 'H bot.exe'), 'test fixture')
  }
  const include = fileURLToPath(new URL('../build/installer.nsh', import.meta.url))
  const cases = [
    { name: 'uninstall record wins over a stale but existing folder', installed: current, registered: stale, expected: current },
    { name: 'custom folder with spaces is retained', installed: current, registered: current, expected: current },
    { name: 'legacy installation registry is retained without an uninstall location', registered: current, expected: current },
    { name: 'invalid uninstall location does not override a valid installation', installed: join(work, 'missing'), registered: current, expected: current },
    { name: 'a fresh installation gets no fabricated existing directory', expected: '' },
  ]
  try {
    for (const uninstaller of [false, true]) {
      const output = join(work, uninstaller ? 'uninstaller-check.exe' : 'installer-check.exe')
      const lines = [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', `OutFile "${output}"`,
        '!include LogicLib.nsh', '!include FileFunc.nsh', '!include x64.nsh',
        '!define APP_ID "io.github.fei2411.dsbot.local"', '!define APP_64',
        '!define APP_EXECUTABLE_FILENAME "H bot.exe"',
        `!define INSTALL_REGISTRY_KEY "${registry}\\install"`,
        `!define UNINSTALL_REGISTRY_KEY "${registry}\\uninstall"`,
        ...(uninstaller ? ['!define BUILD_UNINSTALLER'] : []),
        `!include "${include}"`, 'Section', 'SetRegView 64',
      ]
      for (const [index, scenario] of cases.entries()) {
        lines.push(`DeleteRegKey HKCU "${registry}"`)
        if (scenario.installed) lines.push(`WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" InstallLocation "${scenario.installed}"`)
        if (scenario.registered) lines.push(`WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" InstallLocation "${scenario.registered}"`)
        lines.push('!insertmacro preInit', 'ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
          `WriteINIStr "${join(work, 'result.ini')}" "${uninstaller}" "${index}" "$0"`)
      }
      if (!uninstaller) {
        lines.push('!undef APP_ID', '!define APP_ID "io.github.fei2411.dsbot.local.unlock"',
          `WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" InstallLocation "${stale}"`,
          `WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" InstallLocation "${current}"`,
          '!insertmacro preInit', 'ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
          `WriteINIStr "${join(work, 'result.ini')}" "other-edition" "0" "$0"`)
      }
      lines.push(`DeleteRegKey HKCU "${registry}"`, 'SectionEnd')
      const script = join(work, 'check.nsi')
      writeFileSync(script, lines.join('\r\n'))
      const compiled = spawnSync(compiler, ['-V2', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`)
      const executed = spawnSync(output, [], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
      assert.equal(executed.status, 0, `${executed.error ?? executed.stderr}`)
      const results = readFileSync(join(work, 'result.ini'), 'utf16le')
      const section = results.split(`[${uninstaller}]`)[1].split(/\r?\n\[/u)[0]
      for (const [index, scenario] of cases.entries()) {
        const expected = uninstaller ? (scenario.registered ?? '') : scenario.expected
        assert.ok(section.split(/\r?\n/u).includes(`${index}=${expected}`), `${scenario.name}: ${section}`)
      }
      if (!uninstaller) assert.ok(results.includes(`[other-edition]\r\n0=${stale}\r\n`))
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
