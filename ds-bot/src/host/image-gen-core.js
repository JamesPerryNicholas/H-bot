// Generate an image with the current session's vendor, then show it in the chat.
// The chat model itself cannot emit pixels; this tool calls that vendor's best
// image model. Spend is recorded only when the bundled OpenAI credit is what
// paid for the call. There is no in-app spend cap.
import { splitRef } from './text.js'

export const NO_IMAGE_MODEL_MESSAGE = '此模型厂商没有生图模型'
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.6-sunburst'

const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '1280x1280']
const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'hd', 'standard']
const BACKGROUNDS = ['auto', 'opaque', 'transparent']

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeId(value) {
  return asText(value).toLowerCase()
}

// Best image model first. providers lists H bot / pi-ai ids that belong to the vendor.
export const IMAGE_VENDORS = {
  openai: {
    name: 'OpenAI',
    providers: ['openai', 'openai-codex'],
    models: ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'chatgpt-image-latest'],
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyRefs: ['OPENAI_API_KEY'],
    defaultQuality: 'medium',
    defaultSize: '1024x1024',
  },
  zhipu: {
    name: '智谱',
    providers: ['zai', 'zai-coding-cn'],
    models: ['glm-image', 'cogview-4-250304', 'cogview-4', 'cogview-3-flash'],
    style: 'openai',
    // Image models live on the open platform, not the Coding Plan base URL.
    baseUrlByProvider: {
      zai: 'https://api.z.ai/api/paas/v4',
      'zai-coding-cn': 'https://open.bigmodel.cn/api/paas/v4',
    },
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyRefs: ['ZAI_API_KEY', 'ZAI_CODING_CN_API_KEY'],
    keyRefsByProvider: {
      zai: ['ZAI_API_KEY'],
      'zai-coding-cn': ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'],
    },
    defaultSize: '1280x1280',
    defaultQuality: 'hd',
  },
  xai: {
    name: 'xAI',
    providers: ['xai'],
    models: ['grok-imagine-image-2.0'],
    style: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyRefs: ['XAI_API_KEY'],
    responseFormat: 'b64_json',
    defaultQuality: 'medium',
    extra: { resolution: '2k' },
  },
  google: {
    name: 'Google',
    providers: ['google'],
    models: ['gemini-3-pro-image', 'gemini-nano-banana-2.1', 'gemini-3.1-flash-lite-image'],
    style: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyRefs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
}

const PROVIDER_TO_VENDOR = new Map()
for (const [id, vendor] of Object.entries(IMAGE_VENDORS)) {
  vendor.id = id
  for (const provider of vendor.providers) PROVIDER_TO_VENDOR.set(provider, vendor)
}

export function vendorOfProvider(provider) {
  return PROVIDER_TO_VENDOR.get(normalizeId(provider))
}

export function baseUrlFor(vendor, provider) {
  const id = normalizeId(provider)
  return vendor?.baseUrlByProvider?.[id] || vendor?.baseUrl
}

export function keyRefsFor(vendor, provider) {
  const id = normalizeId(provider)
  return vendor?.keyRefsByProvider?.[id] || vendor?.keyRefs || []
}

export function selectImageTarget({ provider, requestedModel } = {}) {
  const vendor = vendorOfProvider(provider)
  if (!vendor) {
    return { ok: false, message: NO_IMAGE_MODEL_MESSAGE, provider: asText(provider) || undefined }
  }
  const wanted = normalizeId(requestedModel)
  const model = wanted && vendor.models.includes(wanted) ? wanted : vendor.models[0]
  return { ok: true, vendor, model, provider: normalizeId(provider) }
}

export function sessionModelRef(rt, exec) {
  const bot = rt?.botOf?.(rt.selfOf?.(exec?.agent?.id))
  return asText(bot?.model) || asText(bot?.appliedModel) || undefined
}

export function providerFromRef(ref) {
  return splitRef(ref)?.provider
}

// Cordis contexts throw on ctx.credentials unless the service was injected.
// Read through ctx.get(), which does not require inject.
export function readContextService(ctx, name) {
  if (!ctx || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value !== undefined) return value
    } catch { /* get may be unrelated, or the service may be unavailable */ }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

export async function resolveCredentialValue(ctx, refs) {
  const credentials = readContextService(ctx, 'credentials')
  const names = [...new Set((refs ?? []).filter(Boolean))]
  if (credentials && typeof credentials.resolve === 'function') {
    for (const ref of names) {
      try {
        const resolved = await credentials.resolve(ref)
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (asText(value)) return asText(value)
      } catch { /* try the next ref */ }
    }
  }
  for (const ref of names) {
    if (asText(process.env[ref])) return asText(process.env[ref])
  }
  return undefined
}

export function imageUsageFromResponse(body) {
  const usage = body?.usage
  if (!usage || typeof usage !== 'object') return undefined
  const details = usage.input_tokens_details ?? usage.inputTokensDetails ?? {}
  return {
    inputTokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0,
    outputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0,
    textTokens: Number(details.text_tokens ?? details.textTokens ?? 0) || 0,
    imageInputTokens: Number(details.image_tokens ?? details.imageTokens ?? 0) || 0,
    imageOutputTokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0,
  }
}

function mediaTypeOf(format, fallback = 'image/png') {
  const id = normalizeId(format)
  if (id.includes('jpeg') || id.includes('jpg')) return 'image/jpeg'
  if (id.includes('webp')) return 'image/webp'
  if (id.includes('gif')) return 'image/gif'
  if (id.includes('png')) return 'image/png'
  return fallback
}

async function bytesFromUrl(url, fetchImpl) {
  const response = await fetchImpl(url)
  if (!response.ok) throw Object.assign(new Error(`Could not download the generated image (${response.status}).`), { code: 'image-gen/download' })
  const buffer = Buffer.from(await response.arrayBuffer())
  const type = mediaTypeOf(response.headers?.get?.('content-type') ?? '', 'image/png')
  return { bytes: buffer, mediaType: type }
}

function safeErrorMessage(body, status) {
  const err = body?.error
  const message = typeof err?.message === 'string' ? err.message
    : typeof body?.message === 'string' ? body.message
      : `Image generation failed (${status}).`
  return message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/key=[^&\s]+/gi, 'key=[redacted]')
}

export async function requestOpenAiStyleImage({ apiKey, prompt, model, size, quality, background, baseUrl, responseFormat, extra, fetchImpl = fetch }) {
  const payload = { model, prompt, ...(extra ?? {}) }
  if (size) payload.size = size
  if (quality) payload.quality = quality
  if (background) payload.background = background
  if (responseFormat) payload.response_format = payload.output_format ? payload.response_format : responseFormat
  if (responseFormat === 'b64_json' && !payload.output_format) payload.response_format = 'b64_json'
  const endpoint = `${String(baseUrl).replace(/\/$/, '')}/images/generations`
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : {} } catch { body = { raw } }
  if (!response.ok) {
    throw Object.assign(new Error(safeErrorMessage(body, response.status)), { code: body?.error?.code ?? 'image-gen/failed', status: response.status })
  }
  const item = Array.isArray(body?.data) ? body.data[0] : undefined
  const b64 = typeof item?.b64_json === 'string' ? item.b64_json : typeof item?.b64Json === 'string' ? item.b64Json : ''
  if (b64) return { bytes: Buffer.from(b64, 'base64'), mediaType: 'image/png', usage: imageUsageFromResponse(body), model }
  const url = typeof item?.url === 'string' ? item.url : ''
  if (!url) throw Object.assign(new Error('The image API returned no image data.'), { code: 'image-gen/empty' })
  const downloaded = await bytesFromUrl(url, fetchImpl)
  return { ...downloaded, usage: imageUsageFromResponse(body), model }
}

export async function requestGoogleImage({ apiKey, prompt, model, baseUrl, fetchImpl = fetch }) {
  const endpoint = `${String(baseUrl).replace(/\/$/, '')}/models/${model}:generateContent`
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { imageSize: '2K' },
      },
    }),
  })
  const raw = await response.text()
  let body
  try { body = raw ? JSON.parse(raw) : {} } catch { body = { raw } }
  if (!response.ok) {
    throw Object.assign(new Error(safeErrorMessage(body, response.status)), { code: body?.error?.status ?? 'image-gen/failed', status: response.status })
  }
  const parts = body?.candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    const inline = part?.inlineData ?? part?.inline_data
    const data = typeof inline?.data === 'string' ? inline.data : ''
    if (data) {
      return {
        bytes: Buffer.from(data, 'base64'),
        mediaType: mediaTypeOf(inline?.mimeType ?? inline?.mime_type ?? 'image/png'),
        model,
      }
    }
  }
  throw Object.assign(new Error('The image API returned no image data.'), { code: 'image-gen/empty' })
}

export async function requestImage(options) {
  if (options.style === 'google') return requestGoogleImage(options)
  return requestOpenAiStyleImage(options)
}
