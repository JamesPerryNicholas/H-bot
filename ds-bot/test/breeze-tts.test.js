import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BREEZE_DEFAULT_VOICE,
  BREEZE_KEY_REF,
  BREEZE_SAMPLE_RATE,
  BREEZE_TEXT_LIMIT,
  FIRST_FLUSH_LIMIT,
  MIN_FIRST_COMMA_CHARS,
  breezeHeaders,
  breezeRealtimeSessionUrl,
  breezeStreamUrl,
  breezeSyncUrl,
  breezeTtsBody,
  chunkText,
  liveReplyText,
  nextFlushSlice,
  redactTtsError,
  realtimeClientEvents,
} from '../src/shared/breeze-tts.js'
import {
  createRealtimeSession,
  publicSessionView,
  requestSyncTts,
  resolveBreezeKey,
} from '../src/host/breeze-tts.js'
import { createPcmPlayer, createReplySpeaker, PCM_PREROLL_MS, PCM_START_AHEAD_MS } from '../src/client/breeze-tts.js'

const FAKE_KEY = 'brz_test_fake_key_not_real'

test('chunkText splits at the 1000-character limit on punctuation', () => {
  const first = `${'你好啊。'.repeat(250)}结尾。`
  const second = '还有一段。'
  const text = first + second
  assert.ok(text.length > BREEZE_TEXT_LIMIT)
  const parts = chunkText(text)
  assert.ok(parts.length >= 2)
  assert.ok(parts.every(part => part.length <= BREEZE_TEXT_LIMIT))
  assert.equal(parts.join(''), text)
})

test('chunkText keeps a short reply in one part', () => {
  assert.deepEqual(chunkText('你好，世界。'), ['你好，世界。'])
  assert.deepEqual(chunkText(''), [])
})

test('nextFlushSlice does not flush a short opening comma clause', () => {
  assert.ok(MIN_FIRST_COMMA_CHARS >= 40)
  assert.ok(FIRST_FLUSH_LIMIT >= 28 && FIRST_FLUSH_LIMIT <= 36)
  assert.equal(nextFlushSlice('好的，', { first: true }), '')
  assert.equal(nextFlushSlice('好的。', { first: true }), '好的。')
  assert.equal(nextFlushSlice('好的，我们一起看一下。', { first: true }), '好的，我们一起看一下。')
  const pending = '今天天气不错，下午再出门吧。后面再说。'
  const first = nextFlushSlice(pending, { first: true })
  assert.equal(first, '今天天气不错，下午再出门吧。')
  const rest = pending.slice(first.length)
  assert.equal(nextFlushSlice(rest, { first: false }), '后面再说。')
  const longClause = `${'这段话在逗号前要写得足够完整才不会把开头说得很急促'.repeat(2)}，后面还没有句号`
  assert.ok(longClause.indexOf('，') >= MIN_FIRST_COMMA_CHARS)
  assert.equal(nextFlushSlice(longClause, { first: true }), longClause.slice(0, longClause.indexOf('，') + 1))
  assert.equal(nextFlushSlice('还没有标点', { first: true }), '')
  const longPlain = '还没有标点而且已经很长了可以先开口朗读这一段了后面再补上更多字好开始说话'
  assert.ok(longPlain.length > FIRST_FLUSH_LIMIT)
  assert.equal(nextFlushSlice(longPlain, { first: true }), longPlain.slice(0, FIRST_FLUSH_LIMIT))
  assert.equal(nextFlushSlice(longPlain, { first: true, firstLimit: 8 }), longPlain.slice(0, 8))
  // A 24-character comma slice still waits; only a complete short phrase or a
  // much longer clause is flushed on the first pass.
  const shortComma = `${'这段开头还不够长'.repeat(2)}，后面继续`
  assert.ok(shortComma.indexOf('，') < MIN_FIRST_COMMA_CHARS)
  assert.ok(shortComma.indexOf('，') <= 24)
  assert.equal(nextFlushSlice(shortComma, { first: true }), '')
  assert.equal(nextFlushSlice('尾巴', { final: true }), '尾巴')
})

test('host request builders use the official URL, header name, and voice id', () => {
  const voice = BREEZE_DEFAULT_VOICE
  assert.equal(voice, 'voc_88a7brnfb4tb')
  assert.equal(BREEZE_KEY_REF, 'BREEZE_API_KEY')
  assert.equal(breezeSyncUrl(voice, 'mp3'), `https://api.breeze.blue/v1/text-to-speech/${voice}?output_format=mp3`)
  assert.equal(breezeStreamUrl(voice, 'pcm'), `https://api.breeze.blue/v1/text-to-speech/${voice}/stream?output_format=pcm`)
  assert.equal(breezeRealtimeSessionUrl(voice), `https://api.breeze.blue/v1/text-to-speech/${voice}/realtime-sessions`)
  assert.deepEqual(breezeHeaders(FAKE_KEY), { 'xi-api-key': FAKE_KEY, 'content-type': 'application/json' })
  assert.deepEqual(breezeTtsBody('Hello from Breeze.'), { text: 'Hello from Breeze.', model_id: 'breeze-tts-2' })
})

test('createRealtimeSession posts the session URL with xi-api-key and the default voice', async () => {
  const sent = []
  const fetchImpl = async (url, options) => {
    sent.push({ url, options })
    return {
      ok: true,
      text: async () => JSON.stringify({
        websocket_url: 'wss://api.breeze.blue/v1/text-to-speech/voc_88a7brnfb4tb/stream-input?token=fake',
        direct_websocket_url: 'wss://api.breeze.blue/v1/text-to-speech/voc_88a7brnfb4tb/stream-input',
        client_secret: 'fake-client-secret',
        audio_format: { sample_rate: 24000 },
        expires_at: '2099-01-01T00:00:00Z',
      }),
    }
  }
  const session = await createRealtimeSession({ apiKey: FAKE_KEY, fetchImpl })
  assert.equal(session.ok, true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, breezeRealtimeSessionUrl(BREEZE_DEFAULT_VOICE))
  assert.equal(sent[0].options.method, 'POST')
  assert.equal(sent[0].options.headers['xi-api-key'], FAKE_KEY)
  assert.equal(sent[0].options.headers['content-type'], 'application/json')
  const body = JSON.parse(sent[0].options.body)
  assert.equal(body.model_id, 'breeze-tts-2')
  assert.equal(body.output_format, 'pcm')
  const view = publicSessionView(session)
  assert.equal(view.available, true)
  assert.equal(view.voiceId, 'voc_88a7brnfb4tb')
  assert.equal(view.outputFormat, 'pcm')
  assert.equal(view.sampleRate, 24000)
})

test('requestSyncTts uses the convert URL, xi-api-key, and default voice', async () => {
  const sent = []
  const fetchImpl = async (url, options) => {
    sent.push({ url, headers: options.headers, body: options.body })
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }
  }
  const result = await requestSyncTts({ apiKey: FAKE_KEY, text: 'Hello from Breeze.', fetchImpl })
  assert.equal(result.ok, true)
  assert.deepEqual([...result.bytes], [1, 2, 3, 4])
  assert.equal(sent[0].url, breezeSyncUrl(BREEZE_DEFAULT_VOICE, 'mp3'))
  assert.equal(sent[0].headers['xi-api-key'], FAKE_KEY)
  assert.deepEqual(JSON.parse(sent[0].body), { text: 'Hello from Breeze.', model_id: 'breeze-tts-2' })
})

test('createRealtimeSession and resolveBreezeKey fail closed when the key is missing', async () => {
  assert.deepEqual(await createRealtimeSession({ apiKey: '', fetchImpl: async () => { throw new Error('should not fetch') } }), { ok: false, reason: 'no-key' })
  const ctx = { get: () => ({ resolve: async () => undefined }) }
  assert.equal(await resolveBreezeKey(ctx), undefined)
})

test('redactTtsError strips key-shaped values from error text', () => {
  assert.equal(redactTtsError(`failed xi-api-key: ${FAKE_KEY}`), 'failed xi-api-key: [redacted]')
  assert.match(redactTtsError(`token ${FAKE_KEY} leaked`), /\[redacted\]/)
})

test('liveReplyText reads growing text from an open turn', () => {
  const turns = new Map([[7, { data: { get: (key) => key === 'turn-tail' ? { closing: { blocks: [{ kind: 'text', text: '先说这一句。' }] } } : undefined } }]])
  assert.deepEqual(liveReplyText({ timeline: { turns } }, { turn: 7 }), { turn: 7, text: '先说这一句。', done: false })
  assert.equal(liveReplyText({ timeline: { turns } }, undefined), undefined)
})

test('realtime speaker waits for a full first sentence, then plays PCM before the full reply', async () => {
  const sent = []
  const pcm = []
  let messageHandler
  const socket = {
    readyState: 1,
    protocol: 'breeze-realtime-v1',
    send: (payload) => sent.push(JSON.parse(payload)),
    close() { this.readyState = 3 },
    set onmessage(handler) { messageHandler = handler },
    get onmessage() { return messageHandler },
    onopen: undefined,
    onerror: undefined,
  }
  const player = {
    chunks: pcm,
    push(bytes) { pcm.push(bytes) },
    stop() {},
    finished: async () => {},
  }
  const events = realtimeClientEvents()
  const speaker = createReplySpeaker({
    requestSession: async () => ({
      available: true,
      websocketUrl: 'wss://example.test/tts',
      directWebsocketUrl: 'wss://example.test/tts-direct',
      clientSecret: 'fake-client-secret',
    }),
    socketFactory: class {
      constructor() {
        queueMicrotask(() => {
          socket.onopen?.()
          messageHandler?.({ data: JSON.stringify({ type: 'session.ready' }) })
        })
        return socket
      }
    },
    playerFactory: () => player,
    requestSync: async () => { throw new Error('sync should not run') },
    fetchStream: async () => { throw new Error('http stream should not run') },
    systemSpeak: async () => { throw new Error('system should not run') },
  })
  await speaker.prepare()
  const held = await speaker.update('好的，', { final: false })
  assert.equal(held.mode, 'realtime')
  assert.equal(sent.length, 0)
  const early = await speaker.update('好的，我们一起看一下这个问题。后面还有更长的回答。', { final: false })
  assert.equal(early.mode, 'realtime')
  assert.deepEqual(sent[0], events.startTurn())
  assert.deepEqual(sent[1], events.appendText('好的，我们一起看一下这个问题。'))
  assert.deepEqual(sent[2], events.flush())
  assert.equal(sent.some(item => item.type === 'turn.end'), false)
  // Audio can start as soon as the first binary frame arrives, before turn.end.
  messageHandler({ data: new Uint8Array([0, 1, 2, 3]).buffer })
  assert.equal(pcm.length, 1)
  const done = speaker.update('好的，我们一起看一下这个问题。后面还有更长的回答。', { final: true })
  messageHandler({ data: JSON.stringify({ type: 'turn.done' }) })
  assert.equal((await done).mode, 'realtime')
  assert.equal(sent.at(-1).type, 'turn.end')
  speaker.close()
})

test('missing Breeze key falls back to speechSynthesis', async () => {
  const spoken = []
  const speaker = createReplySpeaker({
    requestSession: async () => ({ available: false, reason: 'no-key' }),
    requestSync: async () => { throw new Error('sync should not run') },
    fetchStream: async () => { throw new Error('http stream should not run') },
    systemSpeak: async (text) => { spoken.push(text) },
  })
  const result = await speaker.update('先有鸡还是先有蛋？', { final: true })
  assert.equal(result.mode, 'system')
  assert.deepEqual(spoken, ['先有鸡还是先有蛋？'])
  assert.equal(speaker.note(), 'Using the system voice')
})

test('prepare pre-warms the realtime socket and audio context before the first reply', async () => {
  let sessions = 0
  const context = fakeAudioContext()
  context.state = 'suspended'
  let resumed = 0
  context.resume = async () => { resumed += 1; context.state = 'running' }
  const socket = {
    readyState: 1,
    protocol: 'breeze-realtime-v1',
    send: () => {},
    close() { this.readyState = 3 },
    onopen: undefined,
    onerror: undefined,
  }
  let messageHandler
  Object.defineProperty(socket, 'onmessage', {
    set(handler) { messageHandler = handler },
    get() { return messageHandler },
  })
  const speaker = createReplySpeaker({
    requestSession: async () => {
      sessions += 1
      return {
        available: true,
        websocketUrl: 'wss://example.test/tts',
        directWebsocketUrl: 'wss://example.test/tts-direct',
        clientSecret: 'fake-client-secret',
      }
    },
    socketFactory: class {
      constructor() {
        queueMicrotask(() => {
          socket.onopen?.()
          messageHandler?.({ data: JSON.stringify({ type: 'session.ready' }) })
        })
        return socket
      }
    },
    playerFactory: () => createPcmPlayer({
      contextFactory: () => context,
      sampleRate: BREEZE_SAMPLE_RATE,
      prerollMs: PCM_PREROLL_MS,
      startAheadMs: PCM_START_AHEAD_MS,
    }),
    requestSync: async () => { throw new Error('sync should not run') },
    fetchStream: async () => { throw new Error('http stream should not run') },
    systemSpeak: async () => { throw new Error('system should not run') },
  })
  const prepared = await speaker.prepare()
  assert.equal(prepared.available, true)
  assert.equal(prepared.mode, 'realtime')
  assert.equal(sessions, 1)
  assert.equal(resumed, 1)
  const again = await speaker.prepare()
  assert.equal(again.available, true)
  assert.equal(sessions, 1)
  await speaker.update('好的。', { final: false })
  assert.equal(sessions, 1)
  speaker.close()
})

test('PCM player warm resumes a suspended context before the first buffer arrives', () => {
  const context = fakeAudioContext()
  context.state = 'suspended'
  let resumed = 0
  context.resume = async () => { resumed += 1; context.state = 'running' }
  const player = createPcmPlayer({
    contextFactory: () => context,
    sampleRate: BREEZE_SAMPLE_RATE,
    prerollMs: PCM_PREROLL_MS,
    startAheadMs: PCM_START_AHEAD_MS,
  })
  player.warm()
  assert.equal(resumed, 1)
  player.stop()
})

function pcmBytes(ms, sampleRate = BREEZE_SAMPLE_RATE) {
  const samples = Math.round(sampleRate * ms / 1000)
  return new Uint8Array(samples * 2)
}

function fakeAudioContext() {
  const sources = []
  const context = {
    currentTime: 1,
    state: 'running',
    sources,
    resume: async () => {},
    close: async () => {},
    createBuffer(channels, length, sampleRate) {
      return {
        duration: length / sampleRate,
        length,
        sampleRate,
        getChannelData: () => new Float32Array(length),
      }
    },
    createBufferSource() {
      const source = {
        buffer: null,
        connect() {},
        start(time) { source.startAt = time; sources.push(source) },
        stop() {},
        onended: null,
      }
      return source
    },
  }
  return context
}

test('PCM player prerolls before the first start and schedules the opening slightly ahead', () => {
  assert.ok(PCM_PREROLL_MS >= 40 && PCM_PREROLL_MS <= 80)
  assert.ok(PCM_START_AHEAD_MS >= 20 && PCM_START_AHEAD_MS <= 50)
  const context = fakeAudioContext()
  const player = createPcmPlayer({
    contextFactory: () => context,
    sampleRate: BREEZE_SAMPLE_RATE,
    prerollMs: PCM_PREROLL_MS,
    startAheadMs: PCM_START_AHEAD_MS,
  })
  player.push(pcmBytes(30))
  assert.equal(context.sources.length, 0)
  player.push(pcmBytes(40))
  assert.equal(context.sources.length, 2)
  assert.ok(context.sources[0].startAt >= context.currentTime + 0.02)
  assert.ok(context.sources[0].startAt <= context.currentTime + 0.05)
  const secondStart = context.sources[0].startAt + context.sources[0].buffer.duration
  assert.ok(Math.abs(context.sources[1].startAt - secondStart) < 1e-9)
  player.push(pcmBytes(40))
  assert.equal(context.sources.length, 3)
  const thirdStart = context.sources[1].startAt + context.sources[1].buffer.duration
  assert.ok(Math.abs(context.sources[2].startAt - thirdStart) < 1e-9)
  player.stop()
})

test('PCM player starts a short leftover buffer on finished so a brief reply still plays', async () => {
  const context = fakeAudioContext()
  const player = createPcmPlayer({
    contextFactory: () => context,
    sampleRate: BREEZE_SAMPLE_RATE,
    prerollMs: PCM_PREROLL_MS,
    startAheadMs: PCM_START_AHEAD_MS,
  })
  player.push(pcmBytes(30))
  assert.equal(context.sources.length, 0)
  const wait = player.finished()
  assert.equal(context.sources.length, 1)
  assert.ok(context.sources[0].startAt >= 1 + 0.02)
  context.currentTime = context.sources[0].startAt + context.sources[0].buffer.duration
  context.sources[0].onended?.()
  await wait
  player.stop()
})
