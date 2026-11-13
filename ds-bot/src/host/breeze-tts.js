// Host-side BreezeBlue TTS: resolve the key here, never send it to the renderer.
// Realtime sessions are minted for the voice pane (short-lived client_secret).
// HTTP streaming and sync conversion are the fallbacks when the WebSocket path
// is blocked.
import { resolveCredentialValue } from './image-gen-core.js'
import {
  BREEZE_DEFAULT_VOICE,
  BREEZE_KEY_REF,
  BREEZE_MODEL,
  BREEZE_SAMPLE_RATE,
  BREEZE_TEXT_LIMIT,
  breezeHeaders,
  breezeRealtimeSessionUrl,
  breezeStreamUrl,
  breezeSyncUrl,
  breezeTtsBody,
  chunkText,
  redactTtsError,
} from '../shared/breeze-tts.js'

export * from '../shared/breeze-tts.js'

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export async function resolveBreezeKey(ctx) {
  return resolveCredentialValue(ctx, [BREEZE_KEY_REF])
}

export async function createRealtimeSession({
  apiKey,
  voiceId = BREEZE_DEFAULT_VOICE,
  fetchImpl = fetch,
  modelId = BREEZE_MODEL,
  inactivityTimeoutSeconds = 180,
  outputFormat = 'pcm',
} = {}) {
  if (!asText(apiKey)) return { ok: false, reason: 'no-key' }
  const response = await fetchImpl(breezeRealtimeSessionUrl(voiceId), {
    method: 'POST',
    headers: breezeHeaders(apiKey),
    body: JSON.stringify({
      model_id: modelId,
      output_format: outputFormat,
      inactivity_timeout_seconds: inactivityTimeoutSeconds,
    }),
  })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'http',
      status: response.status,
      message: redactTtsError(body?.error?.message ?? body?.message ?? `TTS session failed (${response.status})`),
    }
  }
  return {
    ok: true,
    voiceId,
    sampleRate: body?.audio_format?.sample_rate ?? BREEZE_SAMPLE_RATE,
    outputFormat,
    websocketUrl: body.websocket_url,
    directWebsocketUrl: body.direct_websocket_url ?? null,
    clientSecret: body.client_secret,
    expiresAt: body.expires_at,
  }
}

export async function requestSyncTts({
  apiKey,
  text,
  voiceId = BREEZE_DEFAULT_VOICE,
  fetchImpl = fetch,
  outputFormat = 'mp3',
} = {}) {
  if (!asText(apiKey)) return { ok: false, reason: 'no-key' }
  const parts = chunkText(text, BREEZE_TEXT_LIMIT)
  if (parts.length === 0) return { ok: false, reason: 'empty' }
  const chunks = []
  for (const part of parts) {
    const response = await fetchImpl(breezeSyncUrl(voiceId, outputFormat), {
      method: 'POST',
      headers: breezeHeaders(apiKey),
      body: JSON.stringify(breezeTtsBody(part)),
    })
    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      return {
        ok: false,
        reason: 'http',
        status: response.status,
        message: redactTtsError(raw.slice(0, 200) || `TTS failed (${response.status})`),
      }
    }
    chunks.push(Buffer.from(await response.arrayBuffer()))
  }
  return { ok: true, bytes: Buffer.concat(chunks), mediaType: outputFormat === 'mp3' ? 'audio/mpeg' : 'application/octet-stream' }
}

export async function openStreamTts({
  apiKey,
  text,
  voiceId = BREEZE_DEFAULT_VOICE,
  fetchImpl = fetch,
  outputFormat = 'pcm',
  signal,
} = {}) {
  if (!asText(apiKey)) return { ok: false, reason: 'no-key' }
  const parts = chunkText(text, BREEZE_TEXT_LIMIT)
  if (parts.length === 0) return { ok: false, reason: 'empty' }
  // The first part is opened immediately so playback can start before later
  // chunks are requested.
  const response = await fetchImpl(breezeStreamUrl(voiceId, outputFormat), {
    method: 'POST',
    headers: breezeHeaders(apiKey),
    body: JSON.stringify(breezeTtsBody(parts[0])),
    signal,
  })
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    return {
      ok: false,
      reason: 'http',
      status: response.status,
      message: redactTtsError(raw.slice(0, 200) || `TTS stream failed (${response.status})`),
    }
  }
  return { ok: true, response, rest: parts.slice(1), voiceId, outputFormat }
}

export function publicSessionView(session) {
  if (!session?.ok) {
    return {
      available: false,
      reason: session?.reason ?? 'error',
      message: session?.message,
      voiceId: BREEZE_DEFAULT_VOICE,
      sampleRate: BREEZE_SAMPLE_RATE,
      outputFormat: 'pcm',
    }
  }
  return {
    available: true,
    mode: 'realtime',
    voiceId: session.voiceId ?? BREEZE_DEFAULT_VOICE,
    sampleRate: session.sampleRate ?? BREEZE_SAMPLE_RATE,
    outputFormat: session.outputFormat ?? 'pcm',
    websocketUrl: session.websocketUrl,
    directWebsocketUrl: session.directWebsocketUrl ?? null,
    clientSecret: session.clientSecret,
    expiresAt: session.expiresAt,
  }
}

export function install(rt) {
  const { ctx } = rt
  const streamFollow = async (rest, voiceId, outputFormat, fetchImpl) => {
    const apiKey = await resolveBreezeKey(ctx)
    if (!apiKey || rest.length === 0) return null
    return fetchImpl(breezeStreamUrl(voiceId, outputFormat), {
      method: 'POST',
      headers: breezeHeaders(apiKey),
      body: JSON.stringify(breezeTtsBody(rest[0])),
    })
  }

  Object.assign(rt, {
    async breezeTtsSession() {
      const apiKey = await resolveBreezeKey(ctx)
      if (!apiKey) return publicSessionView({ ok: false, reason: 'no-key' })
      const session = await createRealtimeSession({ apiKey, voiceId: BREEZE_DEFAULT_VOICE })
      return publicSessionView(session)
    },
    async breezeTtsSpeak(text) {
      const apiKey = await resolveBreezeKey(ctx)
      if (!apiKey) return { available: false, reason: 'no-key' }
      const result = await requestSyncTts({ apiKey, text, voiceId: BREEZE_DEFAULT_VOICE })
      if (!result.ok) return { available: false, reason: result.reason, message: result.message }
      return {
        available: true,
        mediaType: result.mediaType,
        audioBase64: result.bytes.toString('base64'),
      }
    },
    async breezeTtsStreamResponse(body, signal, fetchImpl = fetch) {
      const text = asText(body?.text)
      const outputFormat = body?.outputFormat === 'mp3' ? 'mp3' : 'pcm'
      const apiKey = await resolveBreezeKey(ctx)
      if (!apiKey) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'tts/no-key', message: 'No Breeze voice key is set.' } }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      }
      const opened = await openStreamTts({
        apiKey,
        text,
        voiceId: BREEZE_DEFAULT_VOICE,
        fetchImpl,
        outputFormat,
        signal,
      })
      if (!opened.ok) {
        return new Response(JSON.stringify({ ok: false, error: { code: 'tts/failed', message: opened.message ?? 'TTS stream failed' } }), {
          status: opened.status && opened.status >= 400 ? opened.status : 502,
          headers: { 'content-type': 'application/json' },
        })
      }
      const mediaType = outputFormat === 'mp3' ? 'audio/mpeg' : 'application/octet-stream'
      if (opened.rest.length === 0) {
        return new Response(opened.response.body, { status: 200, headers: { 'content-type': mediaType } })
      }
      const stream = new ReadableStream({
        async start(controller) {
          const write = async (response) => {
            const reader = response.body.getReader()
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              if (value) controller.enqueue(value)
            }
          }
          try {
            await write(opened.response)
            let rest = opened.rest
            while (rest.length > 0) {
              const next = await streamFollow(rest, BREEZE_DEFAULT_VOICE, outputFormat, fetchImpl)
              if (!next?.ok) break
              await write(next)
              rest = rest.slice(1)
            }
            controller.close()
          } catch (error) {
            controller.error(error)
          }
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': mediaType } })
    },
  })
}
