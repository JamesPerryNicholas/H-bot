import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexEngine } from '../src/host/local-agents/codex.js'
import { JsonRpcPeer } from '../src/host/local-agents/jsonrpc.js'

const method = 'mcpServer/elicitation/request'
const params = {
  threadId: 'test-thread', serverName: 'cua_repl', mode: 'form',
  message: 'Allow Codex to use H bot?',
  requestedSchema: { $schema: 'https://json-schema.org/draft-07/schema#', type: 'object', properties: {} },
  _meta: { connector_id: 'computer-use', tool_params: { app: 'H bot' } },
}
function setup() {
  const engine = new CodexEngine('test', {}, {})
  const thread = engine.threadFor('test-session')
  thread.threadId = 'test-thread'
  return { engine, thread }
}

for (const mode of ['form', 'openai/form', 'openaiForm']) {
  test(`${mode}: approval waits for the existing UI callback`, async () => {
    const { engine, thread } = setup()
    let settled = false
    const response = engine.onRequest(method, { ...params, mode }).then(value => { settled = true; return value })
    const event = await thread.next()
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(event.type, 'permission')
    assert.equal(event.action, params.message)
    assert.match(event.detail, /H bot/)
    assert.equal(event.options.find(option => option.kind === 'allow_once').optionId, 'accept')
    event.reply('accept')
    assert.deepEqual(await response, { action: 'accept', content: {} })
  })
}

for (const decision of ['decline', null, undefined, 'acceptForSession', 'unexpected']) {
  test(`non-approval ${String(decision)} declines`, async () => {
    const { engine, thread } = setup()
    const response = engine.onRequest(method, params)
    ;(await thread.next()).reply(decision)
    assert.deepEqual(await response, { action: 'decline' })
  })
}

test('unknown thread cancels without a hanging promise', async () => {
  const { engine } = setup()
  assert.deepEqual(await engine.onRequest(method, { ...params, threadId: 'missing' }), { action: 'cancel' })
})

for (const update of [
  { mode: 'url' }, { mode: 'openai/userVerification' },
  { requestedSchema: { type: 'object', properties: { proof: { type: 'string' } } } },
  { requestedSchema: { type: 'object', required: ['proof'] } },
  { requestedSchema: { type: 'object', properties: {}, minProperties: 1 } },
  { requestedSchema: undefined }, { mode: 'unknown' },
]) {
  test(`unsupported request is never accepted: ${JSON.stringify(update)}`, async () => {
    const { engine, thread } = setup()
    const reply = await engine.onRequest(method, { ...params, ...update })
    assert.equal(reply.action, 'cancel')
    assert.equal(reply._meta['openai/client_unsupported'], true)
    assert.equal((await thread.next()).type, 'activity')
  })
}

test('legacy command approval still returns its original response shape', async () => {
  const { engine, thread } = setup()
  const response = engine.onRequest('item/commandExecution/requestApproval', { threadId: params.threadId, command: 'echo test' })
  ;(await thread.next()).reply('accept')
  assert.deepEqual(await response, { decision: 'accept' })
})

test('JSON-RPC roundtrip returns elicitation response, not method-not-found', async () => {
  const { engine, thread } = setup()
  const written = []
  const peer = new JsonRpcPeer(message => written.push(message))
  peer.requestHandler = (name, args) => engine.onRequest(name, args)
  peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }))
  assert.equal(written.length, 0)
  ;(await thread.next()).reply('decline')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(written, [{ jsonrpc: '2.0', id: 7, result: { action: 'decline' } }])
})

test('unrelated unknown methods remain unsupported', async () => {
  const { engine } = setup()
  await assert.rejects(engine.onRequest('unknown', {}), error => error.code === -32601)
})
