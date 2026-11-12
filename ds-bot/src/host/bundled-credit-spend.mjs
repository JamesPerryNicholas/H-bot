// In-app $20 cap: apply spend against the unlocked bundled credit in DSH_HOME.
// Kept next to the host usage ledger so every model call can meter it, including
// Session turns that the usage page already records, and GPT-Image-2.6 generations.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CREDIT_LIMIT_USD = 20
const STATE_FILE = 'bundled-credit.json'

const RATES_PER_MILLION = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  o3: { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
}
const FALLBACK_RATE = { input: 5, output: 15 }
// Official GPT-Image-2.6 token prices (text input / image input / image output).
const IMAGE_RATES_PER_MILLION = {
  textInput: 5,
  imageInput: 8,
  output: 30,
}
const IMAGE_FALLBACK_USD = 0.08

const count = value => (Number.isFinite(value) && value > 0 ? value : 0)

function rateForModel(model) {
  const id = String(model ?? '').trim().toLowerCase()
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return RATES_PER_MILLION[bare] ?? RATES_PER_MILLION[id] ?? FALLBACK_RATE
}

export function isImageModel(model) {
  const id = String(model ?? '').trim().toLowerCase()
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return bare.startsWith('gpt-image-') || bare.startsWith('chatgpt-image-') || bare.startsWith('dall-e-')
}

export function estimateCostUsd({ model, inputTokens = 0, outputTokens = 0, textTokens = 0, imageInputTokens = 0, imageOutputTokens = 0, kind } = {}) {
  if (kind === 'image' || isImageModel(model)) {
    const text = count(textTokens) || (count(imageInputTokens) > 0 ? 0 : count(inputTokens))
    const imageIn = count(imageInputTokens)
    const imageOut = count(imageOutputTokens) || count(outputTokens)
    const cost = (text / 1e6) * IMAGE_RATES_PER_MILLION.textInput
      + (imageIn / 1e6) * IMAGE_RATES_PER_MILLION.imageInput
      + (imageOut / 1e6) * IMAGE_RATES_PER_MILLION.output
    return cost > 0 ? cost : IMAGE_FALLBACK_USD
  }
  const rate = rateForModel(model)
  return (count(inputTokens) / 1e6) * rate.input + (count(outputTokens) / 1e6) * rate.output
}

function statePath(dataDir) {
  return join(dataDir, STATE_FILE)
}

function readState(dataDir) {
  const file = statePath(dataDir)
  if (!existsSync(file)) return { unlocked: false, spentUsd: 0, exhausted: false }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const spentUsd = Number(raw.spentUsd)
    return {
      unlocked: raw.unlocked === true,
      spentUsd: Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0,
      exhausted: raw.exhausted === true,
      unlockedAt: typeof raw.unlockedAt === 'string' ? raw.unlockedAt : undefined,
      usedSlots: Array.isArray(raw.usedSlots) ? raw.usedSlots : [],
      slotId: typeof raw.slotId === 'string' ? raw.slotId : undefined,
    }
  } catch {
    return { unlocked: false, spentUsd: 0, exhausted: false }
  }
}

function writeState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true })
  const next = {
    unlocked: state.unlocked === true,
    spentUsd: Math.max(0, Number(state.spentUsd) || 0),
    exhausted: state.exhausted === true,
    usedSlots: state.usedSlots ?? [],
    ...(state.unlockedAt ? { unlockedAt: state.unlockedAt } : {}),
    ...(state.slotId ? { slotId: state.slotId } : {}),
  }
  if (next.spentUsd >= CREDIT_LIMIT_USD) next.exhausted = true
  writeFileSync(statePath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function removeBundledKey(dataDir) {
  const credFile = join(dataDir, '.credentials.yaml')
  if (!existsSync(credFile)) return
  const text = readFileSync(credFile, 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const next = lines.filter(line => !/^\s+OPENAI_API_KEY\s*:/.test(line))
  if (next.length !== lines.length) writeFileSync(credFile, `${next.join('\n').replace(/\n+$/, '\n')}`, 'utf8')
}

export function noteBundledSpend(dataDir, { model, usage, kind, costUsd } = {}) {
  if (!dataDir) return undefined
  const state = readState(dataDir)
  if (!state.unlocked || state.exhausted) return state
  let cost = Number(costUsd)
  if (!Number.isFinite(cost) || cost <= 0) {
    const inputTokens = count(usage?.inputTokens) + count(usage?.cacheReadTokens) + count(usage?.cacheWriteTokens)
    const outputTokens = count(usage?.outputTokens)
    cost = estimateCostUsd({
      model,
      kind,
      inputTokens,
      outputTokens,
      textTokens: count(usage?.textTokens),
      imageInputTokens: count(usage?.imageInputTokens),
      imageOutputTokens: count(usage?.imageOutputTokens) || outputTokens,
    })
  }
  if (cost <= 0) return state
  const next = writeState(dataDir, { ...state, spentUsd: state.spentUsd + cost })
  if (next.exhausted) removeBundledKey(dataDir)
  return next
}
