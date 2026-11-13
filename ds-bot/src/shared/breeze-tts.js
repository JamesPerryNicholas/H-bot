// BreezeBlue text-to-speech helpers shared by the host and the voice pane.
// The API key never belongs in this module: callers pass it in, and helpers
// only build URLs, headers, and text slices.

export const BREEZE_API_ORIGIN = 'https://api.breeze.blue'
export const BREEZE_WS_ORIGIN = 'wss://api.breeze.blue'
export const BREEZE_DEFAULT_VOICE = 'voc_88a7brnfb4tb'
export const BREEZE_MODEL = 'breeze-tts-2'
export const BREEZE_KEY_REF = 'BREEZE_API_KEY'
export const BREEZE_TEXT_LIMIT = 1000
export const BREEZE_SAMPLE_RATE = 24000
export const BREEZE_APPEND_LIMIT = 2048

const CLAUSE_END = /[。！？!?；;，,、\n]/
const SENTENCE_END = /[。！？!?\n]/

export function breezeSyncUrl(voiceId = BREEZE_DEFAULT_VOICE, outputFormat = 'mp3') {
  return `${BREEZE_API_ORIGIN}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${outputFormat}`
}

export function breezeStreamUrl(voiceId = BREEZE_DEFAULT_VOICE, outputFormat = 'pcm') {
  return `${BREEZE_API_ORIGIN}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${outputFormat}`
}

export function breezeRealtimeSessionUrl(voiceId = BREEZE_DEFAULT_VOICE) {
  return `${BREEZE_API_ORIGIN}/v1/text-to-speech/${encodeURIComponent(voiceId)}/realtime-sessions`
}

export function breezeRealtimeWsUrl(voiceId = BREEZE_DEFAULT_VOICE, {
  outputFormat = 'pcm',
  modelId = BREEZE_MODEL,
  inactivityTimeoutSeconds = 180,
} = {}) {
  const query = new URLSearchParams({
    output_format: outputFormat,
    model_id: modelId,
    inactivity_timeout_seconds: String(inactivityTimeoutSeconds),
  })
  return `${BREEZE_WS_ORIGIN}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${query}`
}

export function breezeHeaders(apiKey) {
  return { 'xi-api-key': apiKey, 'content-type': 'application/json' }
}

export function breezeTtsBody(text, { modelId = BREEZE_MODEL } = {}) {
  return { text, model_id: modelId }
}

export function redactTtsError(text) {
  return String(text ?? '')
    .replace(/brz_[A-Za-z0-9]+/g, '[redacted]')
    .replace(/xi-api-key:\s*\S+/gi, 'xi-api-key: [redacted]')
    .replace(/client_secret["']?\s*[:=]\s*["']?[^"'\s]+/gi, 'client_secret: [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
}

// Prefer punctuation, then whitespace, then a hard cut, so a long reply stays
// inside the 1000-character HTTP / realtime turn limit.
export function chunkText(text, limit = BREEZE_TEXT_LIMIT) {
  const source = String(text ?? '')
  if (source.length <= limit) return source ? [source] : []
  const parts = []
  let rest = source
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = lastIndex(window, SENTENCE_END)
    if (cut < limit * 0.4) cut = lastIndex(window, CLAUSE_END)
    if (cut < limit * 0.4) cut = lastIndex(window, /\s/)
    if (cut < Math.min(8, limit)) cut = limit
    parts.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) parts.push(rest)
  return parts.filter(Boolean)
}

function lastIndex(text, pattern) {
  let found = -1
  for (let index = 0; index < text.length; index += 1) {
    if (pattern.test(text[index])) found = index + 1
  }
  return found
}

// First flush waits for a sentence end, or a complete short phrase, so a short
// opening like "好的，" is not synthesized alone. Later flushes stay at sentence
// boundaries. The first-phrase limit is kept modest so speech can start sooner
// without going back to flushing a short 24-character comma slice.
export const FIRST_FLUSH_LIMIT = 32
export const MIN_FIRST_COMMA_CHARS = 40

export function nextFlushSlice(pending, { first = false, final = false, firstLimit = FIRST_FLUSH_LIMIT } = {}) {
  const text = String(pending ?? '')
  if (!text) return ''
  if (final) return text
  if (first) {
    const sentence = text.match(/^[\s\S]*?[。！？!?\n]/)
    if (sentence) return sentence[0]
    const clause = text.match(/^[\s\S]*?[；;，,、]/)
    if (clause && visibleLength(clause[0]) >= MIN_FIRST_COMMA_CHARS) return clause[0]
    if (text.length >= firstLimit) return cutPhrase(text, firstLimit)
    return ''
  }
  const match = text.match(/^[\s\S]*?[。！？!?\n]/)
  return match ? match[0] : ''
}

function visibleLength(text) {
  return text.replace(/\s+/g, '').length
}

function cutPhrase(text, limit) {
  const window = text.slice(0, limit)
  const space = window.lastIndexOf(' ')
  if (space >= limit * 0.5) return text.slice(0, space + 1)
  return window
}

export function realtimeClientEvents() {
  return {
    startTurn: (turnId) => (turnId ? { type: 'turn.start', turn_id: turnId } : { type: 'turn.start' }),
    appendText: (text) => ({ type: 'text.append', text }),
    flush: () => ({ type: 'text.flush' }),
    endTurn: () => ({ type: 'turn.end' }),
    cancelTurn: () => ({ type: 'turn.cancel' }),
    ping: () => ({ type: 'ping' }),
    close: () => ({ type: 'session.close' }),
  }
}

export function splitAppend(text, limit = BREEZE_APPEND_LIMIT) {
  const source = String(text ?? '')
  if (!source) return []
  const parts = []
  let rest = source
  while (rest) {
    if (byteLength(rest) <= limit) { parts.push(rest); break }
    let cut = rest.length
    while (cut > 1 && byteLength(rest.slice(0, cut)) > limit) cut -= 1
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return parts
}

function byteLength(text) {
  return typeof Buffer === 'undefined' ? new TextEncoder().encode(text).length : Buffer.byteLength(text)
}

export function textFromBlocks(closing) {
  if (!closing) return ''
  const blocks = closing.blocks ?? closing
  if (!Array.isArray(blocks)) return typeof closing === 'string' ? closing : ''
  return blocks.filter(block => block?.kind === 'text' && String(block.text ?? '').trim() !== '').map(block => block.text).join('\n\n')
}

// Growing Assistant text for an open turn, so voice chat can start speaking
// before the turn closes.
export function liveReplyText(chat, openTurn) {
  const turnId = turnIdOf(openTurn)
  if (turnId == null) return undefined
  const location = chat?.timeline?.turns?.get?.(Number(turnId))
  if (location === undefined) return undefined
  const tail = location.data?.get?.('turn-tail')
  if (tail?.closing !== undefined && tail.closing !== null) {
    return { turn: Number(turnId), text: textFromBlocks(tail.closing), done: false }
  }
  const streaming = tail?.streaming ?? tail?.draft ?? tail?.message
  if (streaming) return { turn: Number(turnId), text: textFromBlocks(streaming), done: false }
  if (Array.isArray(tail?.blocks)) return { turn: Number(turnId), text: textFromBlocks(tail), done: false }
  return { turn: Number(turnId), text: '', done: false }
}

function turnIdOf(openTurn) {
  if (openTurn == null) return undefined
  if (typeof openTurn === 'number' && Number.isFinite(openTurn)) return openTurn
  if (typeof openTurn === 'string' && openTurn !== '' && Number.isFinite(Number(openTurn))) return Number(openTurn)
  return openTurn.turn ?? openTurn.id ?? openTurn.index
}
