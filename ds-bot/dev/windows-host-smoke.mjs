// Boots the real Host with disposable data; no model call or personal profile is used.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostProcess } from '../../app/src/host-process.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const home = mkdtempSync(join(root, '.dsh-test-development-smoke-'))
const workspace = join(home, 'workspace')
mkdirSync(workspace)
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/API_KEY|ACCESS_TOKEN|AUTH_TOKEN/u.test(key) || /^(DSH_|DS_BOT_)/u.test(key)) delete env[key]
}
Object.assign(env, { DSH_HOME: home, DS_BOT_HOME: home, DS_BOT_WORKSPACE: workspace, DS_BOT_USER_DSH_HOME: join(home, 'unused-user-home'), DS_BOT_APP: '1' })
const failures = []
const host = new HostProcess({
  entry: join(root, 'app/src/host.mjs'), cwd: workspace, env,
  pnpm: join(root, 'app/node_modules/pnpm/bin/pnpm.cjs'),
  onFailure: error => failures.push(error),
  output: (stream, text) => appendFileSync(join(home, 'host.log'), `[${stream}] ${text}`),
})
let base, cookie
async function start() {
  let timer
  try {
    const ready = await Promise.race([
      host.start(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Host startup timed out')), 90_000) }),
    ])
    assert.ok(ready.url)
    base = new URL(ready.url).origin
    const login = await fetch(ready.url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.ok(cookie, 'The supported launch URL must establish a session')
  } finally { clearTimeout(timer) }
}
async function api(endpoint, payload = {}) {
  const response = await fetch(`${base}/api/bot`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result.value
}
try {
  await start()
  const denied = await fetch(`${base}/api/bot`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'state' }), signal: AbortSignal.timeout(15_000),
  })
  assert.equal(denied.status, 401)
  const state = await api('state')
  assert.ok(state.mainBotId)
  const title = 'Development smoke task'
  const created = await api('schedule-create', {
    target: state.mainBotId, title, prompt: 'Smoke test only', when: { kind: 'every', minutes: 60 },
  })
  const task = created.tasks.find(value => value.title === title)
  assert.ok(task)
  const reloaded = await api('schedules')
  assert.ok(reloaded.tasks.some(value => value.id === task.id))
  const removed = await api('schedule-delete', { sessionId: task.sessionId, id: task.id })
  assert.ok(!removed.tasks.some(value => value.id === task.id))
  assert.deepEqual(failures, [])
  console.log('PASS: Host startup, authenticated API, unauthenticated 401, schedule create/list/delete')
  console.log(`Isolated test data and redacted log: ${home}`)
} finally { await host.stop() }
