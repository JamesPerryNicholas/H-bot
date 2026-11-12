import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NO_IMAGE_MODEL_MESSAGE,
  baseUrlFor,
  imageUsageFromResponse,
  keyRefsFor,
  requestImage,
  resolveCredentialValue,
  selectImageTarget,
  vendorOfProvider,
} from '../../ds-bot/src/host/image-gen-core.js'
import { estimateCostUsd, isImageModel } from '../../ds-bot/src/host/bundled-credit-spend.mjs'

test('the current session vendor picks its best image model', () => {
  assert.equal(selectImageTarget({ provider: 'openai' }).model, 'gpt-image-2.6-sunburst')
  assert.equal(selectImageTarget({ provider: 'openai-codex' }).model, 'gpt-image-2.6-sunburst')
  assert.equal(selectImageTarget({ provider: 'zai' }).model, 'glm-image')
  assert.equal(selectImageTarget({ provider: 'zai-coding-cn' }).vendor.id, 'zhipu')
  assert.equal(selectImageTarget({ provider: 'xai' }).model, 'grok-imagine-image-2.0')
  assert.equal(selectImageTarget({ provider: 'google' }).model, 'gemini-3-pro-image')
})

test('a vendor without an image model returns the Chinese notice and is not swapped to another vendor', () => {
  const deepseek = selectImageTarget({ provider: 'deepseek' })
  assert.equal(deepseek.ok, false)
  assert.equal(deepseek.message, NO_IMAGE_MODEL_MESSAGE)
  assert.equal(selectImageTarget({ provider: 'anthropic' }).message, NO_IMAGE_MODEL_MESSAGE)
  assert.equal(vendorOfProvider('anthropic'), undefined)
})

test('each vendor resolves its image API base URL and key refs', () => {
  const openai = selectImageTarget({ provider: 'openai' }).vendor
  assert.equal(baseUrlFor(openai, 'openai'), 'https://api.openai.com/v1')
  assert.deepEqual(keyRefsFor(openai, 'openai'), ['OPENAI_API_KEY'])
  const zai = selectImageTarget({ provider: 'zai' }).vendor
  assert.equal(baseUrlFor(zai, 'zai'), 'https://api.z.ai/api/paas/v4')
  assert.deepEqual(keyRefsFor(zai, 'zai'), ['ZAI_API_KEY'])
  const zhipu = selectImageTarget({ provider: 'zai-coding-cn' }).vendor
  assert.equal(baseUrlFor(zhipu, 'zai-coding-cn'), 'https://open.bigmodel.cn/api/paas/v4')
  assert.deepEqual(keyRefsFor(zhipu, 'zai-coding-cn'), ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'])
})


test('image usage is read from snake_case or camelCase', () => {
  assert.deepEqual(imageUsageFromResponse({
    usage: { input_tokens: 10, output_tokens: 200, input_tokens_details: { text_tokens: 10, image_tokens: 0 } },
  }), { inputTokens: 10, outputTokens: 200, textTokens: 10, imageInputTokens: 0, imageOutputTokens: 200 })
})

test('image spend uses official 2.6 rates and a floor when usage is missing', () => {
  assert.equal(isImageModel('gpt-image-2.6-flare'), true)
  const cost = estimateCostUsd({
    kind: 'image',
    model: 'gpt-image-2.6-flare',
    textTokens: 1000,
    imageOutputTokens: 1000,
  })
  assert.ok(Math.abs(cost - ((1000 / 1e6) * 5 + (1000 / 1e6) * 30)) < 1e-12)
  assert.equal(estimateCostUsd({ kind: 'image', model: 'gpt-image-2.6-flare' }), 0.08)
})

test('OpenAI-style generation posts to the Images API and never exposes the key in errors', async () => {
  const seen = {}
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const fetchImpl = async (url, options) => {
    seen.url = url
    seen.auth = options.headers.Authorization
    seen.body = JSON.parse(options.body)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ b64_json: png }],
        usage: { input_tokens: 12, output_tokens: 400, input_tokens_details: { text_tokens: 12 } },
      }),
    }
  }
  const result = await requestImage({
    apiKey: 'sk-test-not-real',
    prompt: 'a red cup',
    model: 'gpt-image-2.6-sunburst',
    size: '1024x1024',
    quality: 'medium',
    baseUrl: 'https://api.openai.com/v1',
    fetchImpl,
  })
  assert.equal(seen.url, 'https://api.openai.com/v1/images/generations')
  assert.equal(seen.body.model, 'gpt-image-2.6-sunburst')
  assert.equal(result.bytes.equals(Buffer.from(png, 'base64')), true)

  const failing = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ error: { message: 'Invalid API key sk-test-not-real' } }),
  })
  await assert.rejects(
    () => requestImage({ apiKey: 'sk-test-not-real', prompt: 'x', model: 'gpt-image-2.6-sunburst', baseUrl: 'https://api.openai.com/v1', fetchImpl: failing }),
    error => {
      assert.equal(String(error.message).includes('sk-test-not-real'), false)
      return true
    },
  )
})

test('a Zhipu URL result is downloaded and Google uses generateContent', async () => {
  const calls = []
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : undefined })
    if (String(url).includes('images/generations')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ url: 'https://cdn.example/z.png' }] }) }
    }
    if (String(url) === 'https://cdn.example/z.png') {
      return { ok: true, status: 200, arrayBuffer: async () => png, headers: { get: () => 'image/png' } }
    }
    if (String(url).includes('generateContent')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }] } }] }),
      }
    }
    throw new Error(`unexpected ${url}`)
  }
  const zhipu = await requestImage({
    apiKey: 'z-test',
    prompt: '猫',
    model: 'glm-image',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    fetchImpl,
  })
  assert.equal(zhipu.bytes.equals(png), true)
  const google = await requestImage({
    style: 'google',
    apiKey: 'g-test',
    prompt: 'a cat',
    model: 'gemini-3-pro-image',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    fetchImpl,
  })
  assert.equal(google.bytes.equals(png), true)
  assert.ok(calls.some(call => String(call.url).includes('models/gemini-3-pro-image:generateContent')))
})


test('resolveCredentialValue reads keys through ctx.get and does not throw when property access requires inject', async () => {
  const service = {
    resolve: async (ref) => ref === 'OPENAI_API_KEY' ? 'sk-from-service' : undefined,
  }
  const throwingCtx = new Proxy({
    get(name) {
      if (name === 'credentials') return service
      return undefined
    },
  }, {
    get(target, prop, receiver) {
      if (prop === 'get') return target.get.bind(target)
      if (prop === 'credentials') throw new Error('cannot get property "credentials" without inject')
      return Reflect.get(target, prop, receiver)
    },
  })
  assert.equal(await resolveCredentialValue(throwingCtx, ['OPENAI_API_KEY']), 'sk-from-service')
  assert.equal(await resolveCredentialValue({ credentials: service }, ['OPENAI_API_KEY']), 'sk-from-service')
})

test('generate_image output schema sets additionalProperties so the team tool can load', async () => {
  const src = await readFile(new URL('../../ds-bot/src/host/image-gen.js', import.meta.url), 'utf8')
  assert.match(src, /schema:\s*\{\s*type:\s*'object',\s*additionalProperties:\s*true\s*\}/)
})
