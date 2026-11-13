// Bundled OpenAI credit: the API key is stored only as ciphertext, unlocked
// by a passphrase the package never keeps in the clear. Spend may be recorded
// for history, but this app no longer applies an in-app hard stop. Official-key
// use follows the OpenAI account itself, not a local meter.

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

export const DEFAULT_PROVIDER = 'openai'
export const DEFAULT_MODEL = 'gpt-4o'
export const KEY_REF = 'OPENAI_API_KEY'
export const STATE_FILE = 'bundled-credit.json'

// scrypt parameters: slow enough to make offline guessing expensive, fast
// enough for a single unlock attempt on a normal PC.
export const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32 }
const SCRYPT_MAXMEM = 256 * 1024 * 1024

const here = dirname(fileURLToPath(import.meta.url))

export function envelopePath(root = here) {
  return join(root, 'bundled-credit-envelope.json')
}

export function loadEnvelope(path = envelopePath()) {
  if (!existsSync(path)) return undefined
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  if (envelopeSlots(raw).length === 0) throw new Error('bundled credit envelope is damaged')
  return raw
}

export const USED_FILE = 'bundled-credit-used.json'

export function envelopeSlots(envelope) {
  if (!envelope || typeof envelope !== 'object') return []
  if (envelope.v === 2 && Array.isArray(envelope.slots)) {
    return envelope.slots.filter(slot => slot && slot.id && slot.salt && slot.iv && slot.tag && slot.data)
  }
  if (envelope.v === 1 && envelope.salt && envelope.iv && envelope.tag && envelope.data) {
    return [{ id: 'legacy', ...envelope }]
  }
  return []
}

function b64(buf) {
  return Buffer.from(buf).toString('base64')
}

function fromB64(text) {
  const buf = Buffer.from(String(text), 'base64')
  if (buf.length === 0) throw new Error('invalid envelope field')
  return buf
}

export async function deriveKey(passphrase, salt, options = SCRYPT) {
  const secret = normalizePassphrase(passphrase)
  if (secret === '') throw new Error('Enter the unlock code')
  return scryptAsync(secret, salt, options.keylen, {
    N: options.N,
    r: options.r,
    p: options.p,
    maxmem: SCRYPT_MAXMEM,
  })
}

export function normalizePassphrase(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export async function sealSecret(plain, passphrase, options = SCRYPT) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(passphrase, salt, options)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    kdf: 'scrypt',
    N: options.N,
    r: options.r,
    p: options.p,
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(tag),
    data: b64(data),
  }
}

export async function sealSecrets(plain, passphrases, options = SCRYPT) {
  const list = []
  for (const value of passphrases ?? []) {
    const pass = normalizePassphrase(value)
    if (pass) list.push(pass)
  }
  if (list.length === 0) throw new Error('missing unlock code')
  if (new Set(list).size !== list.length) throw new Error('unlock codes must be different')
  const slots = []
  for (const pass of list) {
    const one = await sealSecret(plain, pass, options)
    slots.push({
      id: randomBytes(8).toString('hex'),
      kdf: 'scrypt',
      N: one.N,
      r: one.r,
      p: one.p,
      salt: one.salt,
      iv: one.iv,
      tag: one.tag,
      data: one.data,
    })
  }
  return { v: 2, slots }
}

async function openOne(slot, passphrase) {
  const options = {
    N: slot.N ?? SCRYPT.N,
    r: slot.r ?? SCRYPT.r,
    p: slot.p ?? SCRYPT.p,
    keylen: SCRYPT.keylen,
  }
  const key = await deriveKey(passphrase, fromB64(slot.salt), options)
  const decipher = createDecipheriv('aes-256-gcm', key, fromB64(slot.iv))
  decipher.setAuthTag(fromB64(slot.tag))
  const plain = Buffer.concat([decipher.update(fromB64(slot.data)), decipher.final()]).toString('utf8')
  if (!plain) throw invalidCode()
  return plain
}

export async function openSlot(envelope, passphrase, { usedSlotIds = [] } = {}) {
  const used = new Set(usedSlotIds)
  const slots = envelopeSlots(envelope)
  if (slots.length === 0) throw invalidCode()
  let matchedUsed = false
  for (const slot of slots) {
    try {
      const plain = await openOne(slot, passphrase)
      if (used.has(slot.id)) {
        matchedUsed = true
        continue
      }
      return { plain, slotId: slot.id }
    } catch (error) {
      if (error?.code === 'bundled-credit/invalid' || error?.code === 'bundled-credit/used') continue
      // Wrong code or empty passphrase just means this slot did not open.
    }
  }
  if (matchedUsed) throw usedCode()
  throw invalidCode()
}

export async function openSecret(envelope, passphrase, opts) {
  return (await openSlot(envelope, passphrase, opts)).plain
}

function invalidCode() {
  return Object.assign(new Error('That unlock code is not right'), { code: 'bundled-credit/invalid' })
}

function usedCode() {
  return Object.assign(new Error('That unlock code has already been used'), { code: 'bundled-credit/used' })
}

export function usedFile(dir) {
  return join(dir, USED_FILE)
}

export function readUsedSlotIds(dirs = []) {
  const ids = new Set()
  for (const dir of dirs.filter(Boolean)) {
    for (const file of [usedFile(dir), existsSync(dir) ? statePath(dir) : ''].filter(Boolean)) {
      if (!existsSync(file)) continue
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8'))
        for (const id of raw.usedSlots ?? []) if (typeof id === 'string' && id) ids.add(id)
        if (typeof raw.slotId === 'string' && raw.slotId) ids.add(raw.slotId)
      } catch {}
    }
  }
  return [...ids]
}

export function markSlotUsed(dirs, slotId) {
  if (!slotId) return
  for (const dir of dirs.filter(Boolean)) {
    mkdirSync(dir, { recursive: true })
    const ids = new Set(readUsedSlotIds([dir]))
    ids.add(slotId)
    writeFileSync(usedFile(dir), `${JSON.stringify({ usedSlots: [...ids] }, null, 2)}\n`, 'utf8')
  }
}

export function statePath(dataDir) {
  return join(dataDir, STATE_FILE)
}

export function readState(dataDir) {
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
      usedSlots: Array.isArray(raw.usedSlots) ? raw.usedSlots.filter(id => typeof id === 'string') : [],
      slotId: typeof raw.slotId === 'string' ? raw.slotId : undefined,
    }
  } catch {
    return { unlocked: false, spentUsd: 0, exhausted: false, usedSlots: [] }
  }
}

export function writeState(dataDir, state) {
  mkdirSync(dataDir, { recursive: true })
  const usedSlots = [...new Set([...(state.usedSlots ?? []), ...(state.slotId ? [state.slotId] : [])].filter(Boolean))]
  const next = {
    unlocked: state.unlocked === true,
    spentUsd: Math.max(0, Number(state.spentUsd) || 0),
    exhausted: false,
    usedSlots,
    ...(state.unlockedAt ? { unlockedAt: state.unlockedAt } : {}),
    ...(state.slotId ? { slotId: state.slotId } : {}),
  }
  writeFileSync(statePath(dataDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

export function remainingUsd(state) {
  // No in-app remaining cap. Callers should not display a leftover dollar amount.
  if (!state?.unlocked) return null
  return null
}

export function addSpend(dataDir, usd) {
  const state = readState(dataDir)
  const amount = Number(usd)
  if (!state.unlocked || !Number.isFinite(amount) || amount <= 0) return state
  return writeState(dataDir, { ...state, spentUsd: state.spentUsd + amount })
}

// Conservative USD per 1M tokens. Unknown models use a high fallback so
// cost estimates stay on the safe side of published list prices.
export const RATES_PER_MILLION = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  o3: { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
}

export const FALLBACK_RATE = { input: 5, output: 15 }

export function rateForModel(model) {
  const id = String(model ?? '').trim().toLowerCase()
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return RATES_PER_MILLION[bare] ?? RATES_PER_MILLION[id] ?? FALLBACK_RATE
}

export function estimateCostUsd({ model, inputTokens = 0, outputTokens = 0 }) {
  const rate = rateForModel(model)
  const input = Math.max(0, Number(inputTokens) || 0)
  const output = Math.max(0, Number(outputTokens) || 0)
  return (input / 1e6) * rate.input + (output / 1e6) * rate.output
}

function yamlQuote(value) {
  if (/^[\w./+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

export function mergeCredentialRefs(text, refs) {
  const src = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : ''
  if (src.trim() === '') {
    const lines = ['version: 1', 'records: {}', 'refs:']
    for (const [name, value] of Object.entries(refs)) lines.push(`  ${name}: ${yamlQuote(value)}`)
    return `${lines.join('\n')}\n`
  }
  const lines = src.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  let refsIndex = lines.findIndex(line => line === 'refs:' || line.startsWith('refs:'))
  if (refsIndex < 0) {
    lines.push('refs:')
    refsIndex = lines.length - 1
    for (const [name, value] of Object.entries(refs)) lines.push(`  ${name}: ${yamlQuote(value)}`)
    return `${lines.join('\n')}\n`
  }
  const used = new Set()
  for (let i = refsIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line === '' ) continue
    if (!line.startsWith(' ') && !line.startsWith('\t')) break
    const match = line.match(/^\s+([A-Za-z0-9_]+)\s*:/)
    if (!match) continue
    const name = match[1]
    if (name in refs) {
      lines[i] = `  ${name}: ${yamlQuote(refs[name])}`
      used.add(name)
    }
  }
  let insertAt = refsIndex + 1
  while (insertAt < lines.length && (lines[insertAt].startsWith(' ') || lines[insertAt].startsWith('\t') || lines[insertAt] === '')) insertAt += 1
  const extra = Object.entries(refs).filter(([name]) => !used.has(name)).map(([name, value]) => `  ${name}: ${yamlQuote(value)}`)
  if (extra.length) lines.splice(insertAt, 0, ...extra)
  return `${lines.join('\n')}\n`
}

const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

export function mergeModelPatch(text, { provider = DEFAULT_PROVIDER, model = DEFAULT_MODEL, keyRef = KEY_REF } = {}) {
  const openaiBlock = [
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    `      ${provider}:`,
    `        apiKeyEnv: ${keyRef}`,
  ].join('\n')
  const defaultBlock = [
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${provider}`,
    `    model: ${model}`,
  ].join('\n')

  let src = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : ''
  if (src.trim() === '') src = PATCH_HEADER

  src = upsertYamlEntry(src, 'llm-pi-ai', openaiBlock)
  src = upsertYamlEntry(src, 'agent-default-model', defaultBlock)
  if (!src.endsWith('\n')) src += '\n'
  return src
}

function upsertYamlEntry(text, id, block) {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const start = lines.findIndex(line => line === `- id: ${id}` || line.startsWith(`- id: ${id} `))
  if (start < 0) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')
    lines.push(...block.split('\n'))
    return `${lines.join('\n')}\n`
  }
  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('- id: ')) end += 1
  while (end > start + 1 && lines[end - 1] === '') end -= 1
  lines.splice(start, end - start, ...block.split('\n'))
  return `${lines.join('\n')}\n`
}

export function seedOpenAi({ dataDir, apiKey, provider = DEFAULT_PROVIDER, model = DEFAULT_MODEL }) {
  if (!apiKey) throw new Error('missing API key')
  mkdirSync(dataDir, { recursive: true })
  const credFile = join(dataDir, '.credentials.yaml')
  const existingCred = existsSync(credFile) ? readFileSync(credFile, 'utf8') : ''
  writeFileSync(credFile, mergeCredentialRefs(existingCred, { [KEY_REF]: apiKey }), 'utf8')

  const profileDir = join(dataDir, 'profiles', 'ds-bot')
  mkdirSync(profileDir, { recursive: true })
  const patchFile = join(profileDir, 'cordis.patch.yml')
  const existingPatch = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
  writeFileSync(patchFile, mergeModelPatch(existingPatch, { provider, model }), 'utf8')
  return { credFile, patchFile }
}

export function removeBundledKey(dataDir) {
  const credFile = join(dataDir, '.credentials.yaml')
  if (!existsSync(credFile)) return
  const text = readFileSync(credFile, 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const next = lines.filter(line => !/^\s+OPENAI_API_KEY\s*:/.test(line))
  if (next.length !== lines.length) writeFileSync(credFile, `${next.join('\n').replace(/\n+$/, '\n')}`, 'utf8')
}

export async function unlockCredit({ dataDir, passphrase, envelope, usedDir, now = new Date(), once = true }) {
  const packed = envelope ?? loadEnvelope()
  if (!packed) throw new Error('This package has no bundled credit')
  const usedSlotIds = once ? readUsedSlotIds([dataDir, usedDir]) : []
  const { plain: apiKey, slotId } = await openSlot(packed, passphrase, { usedSlotIds })
  seedOpenAi({ dataDir, apiKey })
  if (once) markSlotUsed([dataDir, usedDir], slotId)
  const previous = readState(dataDir)
  const state = writeState(dataDir, {
    unlocked: true,
    spentUsd: previous.spentUsd,
    exhausted: false,
    unlockedAt: now.toISOString(),
    usedSlots: [...new Set([...(previous.usedSlots ?? []), slotId])],
    slotId,
  })
  return { state, remaining: remainingUsd(state), slotId }
}

export function creditStatus(dataDir, { hasEnvelope = existsSync(envelopePath()) } = {}) {
  const state = dataDir && existsSync(dataDir) ? readState(dataDir) : { unlocked: false, spentUsd: 0, exhausted: false }
  return {
    available: hasEnvelope,
    unlocked: state.unlocked,
    exhausted: false,
    remaining: remainingUsd(state),
    limit: null,
  }
}

export function recordUsage(dataDir, usage) {
  const cost = estimateCostUsd(usage)
  if (cost <= 0) return readState(dataDir)
  return addSpend(dataDir, cost)
}

export const VARIANT_FILE = 'bundled-credit-variant.json'
export const OPEN_WRAP_FILE = 'bundled-credit-open-wrap.json'

export function loadVariant(root = here) {
  try {
    const raw = JSON.parse(readFileSync(join(root, VARIANT_FILE), 'utf8'))
    return raw.variant === 'open' ? 'open' : 'unlock'
  } catch {
    return 'unlock'
  }
}

export function loadOpenWrap(root = here) {
  const file = join(root, OPEN_WRAP_FILE)
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const passphrase = typeof raw.passphrase === 'string' ? raw.passphrase.trim() : ''
    return passphrase || undefined
  } catch {
    return undefined
  }
}

export async function unlockOpenCredit({ dataDir, envelope, usedDir, now = new Date() }) {
  const passphrase = loadOpenWrap()
  if (!passphrase) throw new Error('This open package is missing its credit wrap')
  return unlockCredit({ dataDir, passphrase, envelope, usedDir, now, once: false })
}
