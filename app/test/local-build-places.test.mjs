import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'
import { installHooks } from './helpers/register.mjs'

await installHooks()
const { defaultPlaces, chooseLocations, resolvePlaces } = await import('../src/first-run.mjs')
const build = parse(readFileSync(new URL('../electron-builder.local.yml', import.meta.url), 'utf8')).extraMetadata.dsBotBuild

test('local installer shares the same data and workspace as other editions', () => {
  assert.deepEqual(defaultPlaces(build.defaultPlaces), {
    dataDir: join(homedir(), '.ds-bot'), workspace: join(homedir(), 'DS Bot'),
  })
  assert.deepEqual(defaultPlaces(), {
    dataDir: join(homedir(), '.ds-bot'), workspace: join(homedir(), 'DS Bot'),
  })
  assert.equal(build.identity.shellName, 'H bot')
  assert.equal(build.identity.inheritLegacy, false)
  assert.equal(build.automaticUpdates, false)
})

test('a new edition reuses the existing shared team instead of an empty isolated home', () => {
  const shared = defaultPlaces()
  const isolated = { dataName: '.ds-bot-dev', workspaceName: 'DS Bot Dev' }
  const lookup = (dir) => (dir === shared.dataDir ? { id: 'shared' } : undefined)
  assert.deepEqual(resolvePlaces(isolated, lookup), shared)
  assert.deepEqual(resolvePlaces(isolated, () => undefined), defaultPlaces(isolated))
})

test('explicit test directories take priority over local build defaults', () => {
  const previous = { home: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE }
  process.env.DS_BOT_HOME = join(homedir(), '.dsh-test-local-build')
  process.env.DS_BOT_WORKSPACE = join(process.env.DS_BOT_HOME, 'workspace')
  try {
    assert.deepEqual(chooseLocations(build.defaultPlaces), {
      dataDir: process.env.DS_BOT_HOME, workspace: process.env.DS_BOT_WORKSPACE,
    })
  } finally {
    for (const [key, value] of [['DS_BOT_HOME', previous.home], ['DS_BOT_WORKSPACE', previous.workspace]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
