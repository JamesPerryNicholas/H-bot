import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AcpEngine } from '../src/host/local-agents/acp.js'
import { engineOf } from '../src/host/local-agents/engines.js'
import { LoopbackMcp } from '../src/host/local-agents/mcp.js'
import { stdioServer } from '../src/host/local-agents/mcp-stdio.js'
import { JsonRpcPeer, wireProcess } from '../src/host/local-agents/jsonrpc.js'

test('Antigravity starts session workers so team MCP can use HTTP', async t => {
  const spec = engineOf('local-antigravity')
  const fixture = fileURLToPath(new URL('./fixtures/fake-acp.mjs', import.meta.url))
  const engine = new AcpEngine('local-antigravity', { ...spec, command: process.execPath, args: [fixture, '--antigravity', ...spec.args] }, { findExecutable: path => path })
  t.after(() => engine.close())
  await engine.ensure()
  assert.equal(engine.caps.mcpHttp, true)
})

test('ACP without HTTP support receives a stdio MCP server', async () => {
  const engine = new AcpEngine('test', {}, {})
  engine.caps = { mcpHttp: false }
  let params
  engine.ensure = async () => ({ request: async (_method, value) => { params = value; return { sessionId: 'test' } } })
  await engine.open('test', { cwd: process.cwd(), mcp: { url: 'http://127.0.0.1:1/mcp', token: 'test-token' } })
  assert.equal(params.mcpServers[0].command, process.execPath)
  assert.equal(params.mcpServers[0].type, undefined)
  assert.ok(!params.mcpServers[0].args.join(' ').includes('test-token'))
})

test('stdio bridge forwards initialization, tools and SSE results with authentication', async t => {
  const server = new LoopbackMcp(() => [{ name: 'echo', description: 'Echo', parameters: { type: 'object' } }], async call => ({ text: call.arguments.text }))
  await server.listen()
  t.after(() => server.close())
  const spec = stdioServer(server, 'dsbot')
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...Object.fromEntries(spec.env.map(entry => [entry.name, entry.value])) }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  const peer = new JsonRpcPeer(message => child.stdin.write(`${JSON.stringify(message)}\n`))
  wireProcess(child, peer)
  const initialized = await peer.request('initialize', { protocolVersion: '2025-03-26' }, { timeout: 5000 })
  assert.equal(initialized.serverInfo.name, 'ds-bot')
  peer.notify('notifications/initialized', {})
  const tools = await peer.request('tools/list', {}, { timeout: 5000 })
  assert.equal(tools.tools[0].name, 'echo')
  const results = await Promise.all(['one', 'two'].map(text => peer.request('tools/call', { name: 'echo', arguments: { text } }, { timeout: 5000 })))
  assert.deepEqual(results.map(result => result.content[0].text), ['one', 'two'])
})
