import { test } from 'node:test'
import assert from 'node:assert/strict'
const base = new URL('../', import.meta.url).href
const { LocalAgentAdapter } = await import(`${base}src/host/local-agents/adapter.js`)
const { CodexEngine } = await import(`${base}src/host/local-agents/codex.js`)
const { install } = await import(`${base}src/host/local-agents/index.js`)
const defs = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'].map(name => ({ name, parameters: { type: 'object', properties: {} } }))
async function request(mcp, token, method, params) {
 return fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
}

test('authorized MCP lists scheduled task tools and refreshes its scope', async () => {
 const adapter = new LocalAgentAdapter({})
 const live = { pending: new Map(), push() {} }
 const mcp = await adapter.ensureMcp(live, () => defs)
 try {
  const res = await request(mcp, mcp.token, 'tools/list')
  assert.equal(res.status, 200)
  assert.deepEqual((await res.json()).result.tools.map(t => t.name), defs.map(t => t.name))
  await adapter.ensureMcp(live, () => [defs[1]])
  const next = await request(mcp, mcp.token, 'tools/list')
  assert.deepEqual((await next.json()).result.tools.map(t => t.name), ['schedule_list'])
 } finally { mcp.close() }
})

test('MCP authentication remains required', async () => {
 const adapter = new LocalAgentAdapter({})
 const live = { pending: new Map(), push() {} }
 const mcp = await adapter.ensureMcp(live, () => defs)
 try { assert.equal((await request(mcp, 'wrong-token', 'tools/list')).status, 401) }
 finally { mcp.close() }
})

test('schedule calls cross the normal DSH tool bridge with their arguments', async () => {
 const adapter = new LocalAgentAdapter({})
 const live = { pending: new Map(), push(event) {
  assert.equal(event.type, 'call')
  assert.equal(event.name, 'schedule_create')
  assert.equal(event.args.target, 'this_session')
  this.pending.get(event.dshCallId).resolve({ text: JSON.stringify({ id: 'test-task', saved: true }) })
 } }
 const mcp = await adapter.ensureMcp(live, () => defs)
 try {
  const res = await request(mcp, mcp.token, 'tools/call', { name: 'schedule_create', arguments: { title: 'Test', prompt: 'Test', rrule: 'FREQ=HOURLY;INTERVAL=1', target: 'this_session' } })
  const text = await res.text()
  const result = JSON.parse(text.split('data: ')[1].trim()).result
  assert.equal(result.isError, false)
  assert.equal(JSON.parse(result.content[0].text).saved, true)
 } finally { mcp.close() }
})

test('local tools filter includes available schedule tools without exposing unrelated tools', () => {
 let captured
 const ctx = { on() {}, effect() {}, llm: { registerAdapter(routes, adapter) { captured = adapter; return Object.assign(() => {}, { replace() {} }) } } }
 const rt = { ctx, state: { localAgents: { custom: [{ id: 'test' }], sessions: {} } }, teamTools: [{ name: 'list_bots' }] }
 install(rt)
 const all = [...defs, { name: 'list_bots' }, { name: 'approve_agent_action' }, { name: 'exec_command' }, { name: 'arbitrary_admin_tool' }]
 assert.deepEqual(captured.deps.toolsFor({ tools: all }).map(t => t.name), [...defs.map(t => t.name), 'list_bots', 'approve_agent_action'])
 assert.deepEqual(captured.deps.toolsFor({ tools: [defs[1]] }).map(t => t.name), ['schedule_list'])
})

test('new and resumed Codex threads receive MCP credentials inside config overrides', async () => {
 const engine = new CodexEngine('test', {}, {})
 const requests = []
 engine.ensure = async () => ({ async request(method, params) { requests.push({ method, params }); return { thread: { id: 'test-thread' } } } })
 const args = { cwd: 'C:/test', mcp: { url: 'http://127.0.0.1:1/mcp', token: 'fixture-token' } }
 await engine.open('test-session', args)
 await engine.open('test-session', args)
 assert.deepEqual(requests.map(r => r.method), ['thread/start', 'thread/resume'])
 for (const { params } of requests) {
  assert.equal(params.config.mcp_servers.dsbot.url, args.mcp.url)
  assert.equal(params.config.mcp_servers.dsbot.http_headers.Authorization, 'Bearer fixture-token')
 }
})
