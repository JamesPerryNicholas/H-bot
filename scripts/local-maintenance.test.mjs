import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSnapshot, inside, loadConfig, maintain, runCheck, sourceFiles, supportedNode } from './local-maintenance.mjs'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'h-bot-maintenance-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const folder of ['app/src', 'ds-bot/src', 'scripts']) await mkdir(join(dir, folder), { recursive: true })
  await writeFile(join(dir, 'app/src/main.mjs'), 'export const value = 1\n')
  await writeFile(join(dir, 'maintenance.config.json'), JSON.stringify({ schemaVersion: 1, minimumNode: '24.9.0', outputDir: '.h-bot-maintenance', checkTimeoutMs: 10000, checks: ['maintenance-tests'] }))
  return dir
}

test('snapshot preserves source bytes and hashes, excluding dependencies and private data', async t => {
  const root = await fixture(t)
  for (const folder of ['app/node_modules/private', 'ds-bot/.dsh-test-home', '.ds-bot-local', 'app/build']) {
    await mkdir(join(root, folder), { recursive: true })
    await writeFile(join(root, folder, 'private.txt'), 'must not be copied')
  }
  await writeFile(join(root, 'app/.env'), 'must not be copied')
  await writeFile(join(root, 'ds-bot/.credentials.yaml'), 'must not be copied')
  const output = join(root, '.h-bot-maintenance')
  const files = await sourceFiles(root, output)
  assert.equal(files.length, 2)
  const snapshot = join(output, 'source')
  const manifest = await createSnapshot(root, snapshot, files)
  const bytes = await readFile(join(snapshot, 'app/src/main.mjs'))
  assert.equal(bytes.toString(), 'export const value = 1\n')
  const item = manifest.find(entry => entry.path === 'app/src/main.mjs')
  assert.equal(item.sha256, createHash('sha256').update(bytes).digest('hex'))
  await assert.rejects(createSnapshot(root, snapshot, files), { code: 'EEXIST' })
})

test('snapshot refuses a source link that could include files outside the project', async t => {
  const root = await fixture(t)
  const outside = await mkdtemp(join(tmpdir(), 'h-bot-maintenance-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(root, 'app/src/outside'), 'junction')
  await assert.rejects(sourceFiles(root, join(root, '.h-bot-maintenance')), /refuses a link/)
})

test('output paths stay strictly inside the project', async t => {
  const root = await fixture(t)
  assert.equal(inside(root, root), false)
  assert.equal(inside(root, join(root, '..', 'other')), false)
  assert.equal(inside(root, join(root, 'reports')), true)
  const configPath = join(root, 'maintenance.config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.outputDir = '..'
  await writeFile(configPath, JSON.stringify(config))
  await assert.rejects(loadConfig(root), /inside the source/)
})

test('check failures retain stdout, stderr and the actual nonzero exit code', async t => {
  const root = await fixture(t)
  const log = join(root, 'check.log')
  const result = await runCheck('fails', { cwd: root, args: ['-e', 'console.log("out"); console.error("err"); process.exit(7)'] }, log, 10000)
  assert.equal(result.passed, false)
  assert.equal(result.code, 7)
  assert.equal(result.timedOut, false)
  const text = await readFile(log, 'utf8')
  assert.match(text, /out/)
  assert.match(text, /err/)
})

test('a hung check is stopped and fails even if it would otherwise exit successfully', async t => {
  const root = await fixture(t)
  const result = await runCheck('hang', { cwd: root, args: ['-e', 'setInterval(() => {}, 1000)'] }, join(root, 'hang.log'), 200)
  assert.equal(result.passed, false)
  assert.equal(result.timedOut, true)
})

test('snapshot-only runs keep the previous check result and refuse an overlapping run', async t => {
  const root = await fixture(t)
  const output = join(root, '.h-bot-maintenance')
  await mkdir(output)
  await writeFile(join(output, 'last-report.json'), '{"passed":false}')
  const report = await maintain(root, 'snapshot')
  assert.equal(report.fileCount, 2)
  assert.deepEqual(report.checks, [])
  assert.equal(await readFile(join(output, 'last-report.json'), 'utf8'), '{"passed":false}')
  await writeFile(join(output, 'running.lock'), '{"pid":1}')
  await assert.rejects(maintain(root, 'snapshot'), /Another maintenance run/)
  assert.equal(await readFile(join(output, 'running.lock'), 'utf8'), '{"pid":1}')
})

test('maintenance rejects unknown checks before producing any result', async t => {
  const root = await fixture(t)
  const configPath = join(root, 'maintenance.config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.checks = ['invented-check']
  await writeFile(configPath, JSON.stringify(config))
  await assert.rejects(maintain(root, 'check'), /Unknown check/)
})

test('a failed pipeline records failure and names the checks it did not run', async t => {
  const root = await fixture(t)
  const configPath = join(root, 'maintenance.config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8'))
  config.checks = ['maintenance-tests', 'desktop-tests']
  await writeFile(configPath, JSON.stringify(config))
  await writeFile(join(root, 'scripts/local-maintenance.test.mjs'), 'throw new Error("intentional failure")\n')
  const report = await maintain(root, 'check')
  assert.equal(report.passed, false)
  assert.equal(report.checks.length, 1)
  assert.deepEqual(report.notRun, ['desktop-tests'])
  const saved = JSON.parse(await readFile(join(root, '.h-bot-maintenance/last-report.json'), 'utf8'))
  assert.equal(saved.passed, false)
  assert.equal(saved.checks[0].code, 1)
})

test('a check cannot certify source that changed while it was running', async t => {
  const root = await fixture(t)
  await writeFile(join(root, 'scripts/local-maintenance.test.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("app/src/main.mjs", "changed during verification")\n')
  const report = await maintain(root, 'check')
  assert.equal(report.checks[0].passed, true)
  assert.equal(report.passed, false)
  assert.deepEqual(report.changedDuringRun, ['app/src/main.mjs'])
})

test('Node versions compare numerically with the project minimum', () => {
  assert.equal(supportedNode('24.21.0', '24.9.0'), true)
  assert.equal(supportedNode('24.9.0', '24.9.0'), true)
  assert.equal(supportedNode('22.23.2', '24.9.0'), false)
  assert.equal(supportedNode('24.8.9', '24.9.0'), false)
})
