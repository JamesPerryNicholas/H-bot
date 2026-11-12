// Team tool wrapper. Pure selection and API helpers live in image-gen-core.js
// so unit tests do not need @deepseek-ai/dsh-tools.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { noteBundledSpend } from './bundled-credit-spend.mjs'
import {
  NO_IMAGE_MODEL_MESSAGE,
  baseUrlFor,
  keyRefsFor,
  providerFromRef,
  readContextService,
  requestImage,
  resolveCredentialValue,
  selectImageTarget,
  sessionModelRef,
} from './image-gen-core.js'

export * from './image-gen-core.js'

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '1280x1280']
const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'hd', 'standard']
const BACKGROUNDS = ['auto', 'opaque', 'transparent']

async function saveGeneratedImage(ctx, bytes, model, mediaType) {
  const attachments = readContextService(ctx, 'attachments')
  if (typeof attachments?.saveImage !== 'function') {
    throw Object.assign(new Error('This session cannot attach a generated image.'), { code: 'image-gen/attach' })
  }
  const ext = mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/webp' ? 'webp' : 'png'
  return attachments.saveImage({
    mediaType: mediaType || 'image/png',
    data: bytes,
    name: `${model}.${ext}`,
  })
}

export function install(rt) {
  const { ctx } = rt
  rt.teamTools.push(defineTool({
    name: 'generate_image',
    description: 'Generate an image from a text prompt and show it in this chat. Use this when the user asks to draw, illustrate, design, or create a picture. The tool automatically uses the best image model from the same vendor as the current conversation. If that vendor has no image model, it reports that in Chinese and does not call another vendor.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'A detailed description of the image to generate.' },
      size: { type: 'string', description: 'Optional size, such as 1024x1024 or 1280x1280. Ignored when the vendor does not accept it.' },
      quality: { type: 'string', description: 'Optional quality. Ignored when the vendor does not accept it.' },
      background: { type: 'string', description: 'Optional background: auto, opaque, or transparent. OpenAI only.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => {
        if (value?.attachment) {
          return [
            { type: 'text', text: String(value.text ?? '') },
            { type: 'image', attachment: value.attachment },
          ]
        }
        return [{ type: 'text', text: String(value?.text ?? value ?? '') }]
      },
    },
    execute: async (args, exec) => {
      const prompt = asText(args?.prompt)
      if (prompt === '') throw Object.assign(new Error('A prompt is required to generate an image.'), { code: 'bot/invalid' })
      await rt.load?.()
      const selected = selectImageTarget({ provider: providerFromRef(sessionModelRef(rt, exec)) })
      if (!selected.ok) return { text: selected.message }
      const size = asText(args?.size) || selected.vendor.defaultSize || (selected.vendor.id === 'openai' ? '1024x1024' : undefined)
      const quality = asText(args?.quality) || selected.vendor.defaultQuality || (selected.vendor.id === 'openai' ? 'medium' : undefined)
      const background = asText(args?.background)
      if (size && !SIZES.includes(size)) throw Object.assign(new Error(`Size must be one of ${SIZES.join(', ')}.`), { code: 'bot/invalid' })
      if (quality && !QUALITIES.includes(quality)) throw Object.assign(new Error(`Quality must be one of ${QUALITIES.join(', ')}.`), { code: 'bot/invalid' })
      if (background && !BACKGROUNDS.includes(background)) throw Object.assign(new Error(`Background must be one of ${BACKGROUNDS.join(', ')}.`), { code: 'bot/invalid' })
      const apiKey = await resolveCredentialValue(ctx, keyRefsFor(selected.vendor, selected.provider))
      if (!apiKey) {
        throw Object.assign(new Error(`No API key is set for ${selected.vendor.name}. Add one in Settings → Models.`), { code: 'image-gen/no-key' })
      }
      const result = await requestImage({
        style: selected.vendor.style,
        apiKey,
        prompt,
        model: selected.model,
        size,
        quality,
        background: background || undefined,
        baseUrl: baseUrlFor(selected.vendor, selected.provider),
        responseFormat: selected.vendor.responseFormat,
        extra: selected.vendor.extra,
      })
      if (selected.vendor.id === 'openai') {
        try { noteBundledSpend(process.env.DSH_HOME, { model: selected.model, usage: result.usage, kind: 'image' }) } catch (error) {
          rt.warn?.('ds-bot: bundled credit could not record image spend: %s', error)
        }
      }
      const attachment = await saveGeneratedImage(ctx, result.bytes, selected.model, result.mediaType)
      return { text: `已用 ${selected.model} 生成图片。`, attachment, model: selected.model }
    },
  }))
}
