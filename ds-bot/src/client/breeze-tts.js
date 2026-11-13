// Voice-chat playback through BreezeBlue. Prefers one realtime WebSocket kept
// across turns, PCM 24 kHz played after a short cushion so the opening is not clipped.
// Falls back to HTTP streaming, then sync MP3, then speechSynthesis.
// The long-lived API key never reaches this module.
import { call } from './api.js'
import {
  BREEZE_SAMPLE_RATE,
  nextFlushSlice,
  realtimeClientEvents,
  splitAppend,
} from '../shared/breeze-tts.js'

const events = realtimeClientEvents()
const STREAM_ROUTE = 'api/bot-tts'

export const PCM_PREROLL_MS = 60
export const PCM_START_AHEAD_MS = 30

export function createPcmPlayer({
  contextFactory,
  sampleRate = BREEZE_SAMPLE_RATE,
  prerollMs = PCM_PREROLL_MS,
  startAheadMs = PCM_START_AHEAD_MS,
} = {}) {
  let context
  let nextTime = 0
  let leftover = new Uint8Array(0)
  let lastSource = null
  let ended = Promise.resolve()
  let resolveEnded = () => {}
  let started = false
  const pending = []
  let pendingDuration = 0

  const ensure = () => {
    if (context) return context
    context = contextFactory
      ? contextFactory({ sampleRate })
      : (typeof AudioContext === 'function' ? new AudioContext({ sampleRate }) : null)
    return context
  }

  const markPending = () => {
    ended = new Promise((resolve) => { resolveEnded = resolve })
  }

  const bufferFromSamples = (audio, samples) => {
    const buffer = audio.createBuffer(1, samples.length, sampleRate)
    const data = buffer.getChannelData(0)
    for (let index = 0; index < samples.length; index += 1) data[index] = samples[index] / 32768
    return buffer
  }

  const schedule = (buffer) => {
    const audio = ensure()
    if (!audio) return
    const source = audio.createBufferSource()
    source.buffer = buffer
    source.connect(audio.destination)
    const start = Math.max(audio.currentTime, nextTime)
    source.start(start)
    nextTime = start + buffer.duration
    lastSource = source
    source.onended = () => {
      if (lastSource === source && audio.currentTime >= nextTime - 0.01) resolveEnded()
    }
  }

  const flushPending = (force = false) => {
    if (started) {
      while (pending.length > 0) schedule(pending.shift())
      pendingDuration = 0
      return
    }
    if (pending.length === 0) return
    const prerollSec = Math.max(0, prerollMs) / 1000
    if (!force && pendingDuration < prerollSec) return
    const audio = ensure()
    if (!audio) return
    if (audio.state === 'suspended' && typeof audio.resume === 'function') void audio.resume()
    started = true
    markPending()
    nextTime = (audio.currentTime ?? 0) + Math.max(0, startAheadMs) / 1000
    while (pending.length > 0) schedule(pending.shift())
    pendingDuration = 0
  }

  return {
    push(bytes) {
      if (!bytes || bytes.byteLength === 0) return
      const incoming = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      const joined = new Uint8Array(leftover.length + incoming.length)
      joined.set(leftover)
      joined.set(incoming, leftover.length)
      const even = joined.byteLength - (joined.byteLength % 2)
      leftover = even < joined.byteLength ? joined.slice(even) : new Uint8Array(0)
      if (even < 2) return
      const audio = ensure()
      if (!audio) return
      if (audio.state === 'suspended' && typeof audio.resume === 'function') void audio.resume()
      const samples = new Int16Array(joined.buffer, joined.byteOffset, even / 2)
      const buffer = bufferFromSamples(audio, samples)
      pending.push(buffer)
      pendingDuration += buffer.duration
      flushPending(false)
    },
    stop() {
      leftover = new Uint8Array(0)
      pending.length = 0
      pendingDuration = 0
      started = false
      try { lastSource?.stop?.() } catch { /* already stopped */ }
      nextTime = 0
      lastSource = null
      resolveEnded()
      const current = context
      context = undefined
      void current?.close?.().catch?.(() => {})
    },
    finished() {
      flushPending(true)
      if (!context || nextTime <= (context.currentTime ?? 0)) return Promise.resolve()
      return ended
    },
    // Open and resume the audio context during voice-chat setup, so the first
    // spoken frame is not waiting on context creation.
    warm() {
      const audio = ensure()
      if (audio?.state === 'suspended' && typeof audio.resume === 'function') void audio.resume()
      return audio
    },
  }
}

export function connectRealtimeSocket(session, { socketFactory, onPcm, onReady, onTurnDone, onError } = {}) {
  const direct = Boolean(session?.directWebsocketUrl)
  const url = direct ? session.directWebsocketUrl : session.websocketUrl
  if (!url) throw new Error('No realtime TTS socket')
  const protocols = direct ? ['breeze-realtime-v1', `breeze-realtime-token.${session.clientSecret}`] : undefined
  const Factory = socketFactory ?? (typeof WebSocket === 'function' ? WebSocket : undefined)
  if (!Factory) throw new Error('WebSocket is not available')
  const socket = protocols ? new Factory(url, protocols) : new Factory(url)
  if ('binaryType' in socket) socket.binaryType = 'arraybuffer'
  socket.onmessage = (event) => {
    const payload = event?.data
    if (payload instanceof ArrayBuffer || (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView?.(payload)) || (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(payload))) {
      onPcm?.(payload)
      return
    }
    if (typeof Blob !== 'undefined' && payload instanceof Blob) {
      void payload.arrayBuffer().then(buffer => onPcm?.(buffer))
      return
    }
    if (typeof payload !== 'string') return
    let message
    try { message = JSON.parse(payload) } catch { return }
    if (message.type === 'session.ready') onReady?.(message)
    else if (message.type === 'turn.done' || message.type === 'turn.cancelled') onTurnDone?.(message)
    else if (message.type === 'error') onError?.(message)
  }
  socket.onerror = () => onError?.({ type: 'error', message: 'WebSocket connection failed' })
  return socket
}

function send(socket, message) {
  if (!socket || socket.readyState !== 1) return false
  socket.send(typeof message === 'string' ? message : JSON.stringify(message))
  return true
}

export function createReplySpeaker({
  requestSession = () => call('tts-session'),
  requestSync = (text) => call('tts-speak', { text }),
  fetchStream = (text, signal) => fetch(STREAM_ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, outputFormat: 'pcm' }),
    signal,
  }),
  socketFactory,
  playerFactory = createPcmPlayer,
  systemSpeak,
} = {}) {
  let session
  let socket
  let ready
  let player
  let sent = ''
  let firstFlush = true
  let turnOpen = false
  let turnDone
  let resolveTurnDone = () => {}
  let pingTimer
  let unavailable = false
  let note

  const ensurePlayer = () => { player ??= playerFactory(); return player }
  const resetTurn = () => {
    sent = ''
    firstFlush = true
    turnOpen = false
  }
  const armTurnDone = () => {
    turnDone = new Promise((resolve) => { resolveTurnDone = resolve })
  }
  const closeSocket = () => {
    clearInterval(pingTimer)
    pingTimer = undefined
    try { send(socket, events.close()) } catch { /* ignore */ }
    try { socket?.close?.() } catch { /* ignore */ }
    socket = undefined
    session = undefined
    ready = undefined
  }

  const attachSocket = (next) => {
    armTurnDone()
    socket = connectRealtimeSocket(next, {
      socketFactory,
      onPcm: (bytes) => ensurePlayer().push(bytes),
      onReady: () => { ready?.() },
      onTurnDone: () => resolveTurnDone(),
      onError: () => { resolveTurnDone(); closeSocket() },
    })
    ready = undefined
    const opened = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('TTS socket timed out')), 8000)
      ready = () => { clearTimeout(timeout); resolve() }
      socket.onopen = () => {
        if (next.directWebsocketUrl && socket.protocol && socket.protocol !== 'breeze-realtime-v1') {
          clearTimeout(timeout)
          reject(new Error('Direct WebSocket did not negotiate breeze-realtime-v1'))
        }
      }
      const previous = socket.onerror
      socket.onerror = (event) => {
        previous?.(event)
        clearTimeout(timeout)
        reject(new Error('WebSocket connection failed'))
      }
    })
    pingTimer = setInterval(() => send(socket, events.ping()), 20000)
    return opened
  }

  const prepare = async () => {
    ensurePlayer().warm?.()
    if (unavailable) return { available: false }
    if (socket && socket.readyState === 1) return { available: true, mode: 'realtime' }
    closeSocket()
    try {
      const value = await requestSession()
      if (!value?.available) {
        unavailable = value?.reason === 'no-key'
        return { available: false, reason: value?.reason }
      }
      session = value
      await attachSocket(value)
      return { available: true, mode: 'realtime' }
    } catch {
      session = undefined
      return { available: false, reason: 'socket' }
    }
  }

  const beginTurn = () => {
    if (turnOpen) return true
    if (!send(socket, events.startTurn())) return false
    turnOpen = true
    armTurnDone()
    return true
  }

  const appendFlush = (slice, shouldFlush) => {
    if (!slice) return true
    if (!beginTurn()) return false
    for (const part of splitAppend(slice)) {
      if (!send(socket, events.appendText(part))) return false
    }
    sent += slice
    if (shouldFlush && !send(socket, events.flush())) return false
    return true
  }

  const playStream = async (text) => {
    const audio = ensurePlayer()
    const response = await fetchStream(text)
    if (!response?.ok) throw new Error('TTS stream failed')
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) audio.push(value)
    }
    await audio.finished()
  }

  const playSync = async (text) => {
    const value = await requestSync(text)
    if (!value?.available || !value.audioBase64) throw new Error(value?.reason ?? 'sync-failed')
    const binary = atob(value.audioBase64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const blob = new Blob([bytes], { type: value.mediaType ?? 'audio/mpeg' })
    const url = URL.createObjectURL(blob)
    try {
      await new Promise((resolve, reject) => {
        const audio = new Audio(url)
        audio.onended = resolve
        audio.onerror = reject
        const play = audio.play()
        if (play && typeof play.then === 'function') play.catch(reject)
      })
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const fallback = async (text) => {
    if (typeof systemSpeak === 'function') {
      note = 'Using the system voice'
      await systemSpeak(text)
      return 'system'
    }
    throw new Error('No TTS fallback')
  }

  return {
    note: () => note,
    async prepare() {
      return prepare()
    },
    async update(fullText, { final = false } = {}) {
      note = undefined
      const current = String(fullText ?? '')
      if (!current && !final) return { mode: 'idle' }
      const prepared = await prepare()
      if (prepared.available && socket && socket.readyState === 1) {
        const pending = current.slice(sent.length)
        const slice = nextFlushSlice(pending, { first: firstFlush, final })
        if (slice) {
          if (!appendFlush(slice, true)) {
            closeSocket()
          } else {
            firstFlush = false
          }
        }
        if (final && socket) {
          const rest = current.slice(sent.length)
          if (rest) appendFlush(rest, false)
          send(socket, events.endTurn())
          turnOpen = false
          await (turnDone ?? Promise.resolve())
          await (player?.finished?.() ?? Promise.resolve())
          resetTurn()
          return { mode: 'realtime' }
        }
        if (socket) return { mode: 'realtime' }
      }
      if (!final) return { mode: 'pending' }
      if (prepared.reason !== 'no-key') {
        try {
          await playStream(current)
          resetTurn()
          return { mode: 'http-stream' }
        } catch {
          try {
            await playSync(current)
            resetTurn()
            return { mode: 'sync' }
          } catch { /* system voice below */ }
        }
      }
      await fallback(current)
      resetTurn()
      return { mode: 'system' }
    },
    cancel() {
      if (turnOpen) send(socket, events.cancelTurn())
      player?.stop()
      player = undefined
      resetTurn()
    },
    close() {
      this.cancel()
      closeSocket()
    },
  }
}

export function systemUtteranceSpeak(text, { speechSynthesis, SpeechSynthesisUtterance, lang } = {}) {
  const synth = speechSynthesis ?? (typeof window !== 'undefined' ? window.speechSynthesis : undefined)
  const Utterance = SpeechSynthesisUtterance ?? (typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined)
  if (!synth || !Utterance || !text) return Promise.resolve()
  return new Promise((resolve) => {
    const utterance = new Utterance(text)
    utterance.lang = lang ?? (/[\u3400-\u9fff]/.test(text) ? 'zh-CN' : 'en-US')
    utterance.onend = () => resolve()
    utterance.onerror = () => resolve()
    synth.cancel()
    synth.speak(utterance)
  })
}
