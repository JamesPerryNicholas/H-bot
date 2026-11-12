import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CREDIT_LIMIT_USD, addSpend, estimateCostUsd, mergeCredentialRefs, mergeModelPatch,
  openSecret, readState, recordUsage, remainingUsd, sealSecret, sealSecrets, seedOpenAi,
  unlockCredit, writeState,
} from '../src/bundled-credit.mjs'

test('a wrong passphrase cannot open the sealed key', async () => {
  const envelope = await sealSecret('sk-test-secret-value', 'alpha-code')
  const text = JSON.stringify(envelope)
  assert.equal(text.includes('alpha-code'), false)
  assert.equal(text.includes('sk-test-secret-value'), false)
  const plain = await openSecret(envelope, 'alpha-code')
  assert.equal(plain, 'sk-test-secret-value')
  await assert.rejects(() => openSecret(envelope, 'wrong'), { code: 'bundled-credit/invalid' })
  await assert.rejects(() => openSecret(envelope, ''), { code: 'bundled-credit/invalid' })
})

test('trimming only ends of the unlock code still works', async () => {
  const envelope = await sealSecret('sk-abc', 'alpha-code')
  assert.equal(await openSecret(envelope, '  alpha-code  '), 'sk-abc')
})

test('each unlock code can be used only once, and the other code still works', async () => {
  const envelope = await sealSecrets('sk-shared-key', ['alpha-code', 'beta-code'])
  const text = JSON.stringify(envelope)
  assert.equal(text.includes('alpha-code'), false)
  assert.equal(text.includes('beta-code'), false)
  assert.equal(envelope.v, 2)
  assert.equal(envelope.slots.length, 2)

  const usedDir = await mkdtemp(join(tmpdir(), 'hbot-used-'))
  const first = await mkdtemp(join(tmpdir(), 'hbot-credit-a-'))
  const second = await mkdtemp(join(tmpdir(), 'hbot-credit-b-'))
  try {
    const opened = await unlockCredit({ dataDir: first, passphrase: 'alpha-code', envelope, usedDir, now: new Date('2026-11-10T10:00:00Z') })
    assert.equal(opened.state.unlocked, true)
    await assert.rejects(
      () => unlockCredit({ dataDir: second, passphrase: 'alpha-code', envelope, usedDir }),
      { code: 'bundled-credit/used' },
    )
    const other = await unlockCredit({ dataDir: second, passphrase: 'beta-code', envelope, usedDir, now: new Date('2026-11-10T10:01:00Z') })
    assert.equal(other.state.unlocked, true)
    assert.notEqual(opened.slotId, other.slotId)
    await assert.rejects(
      () => unlockCredit({ dataDir: first, passphrase: 'beta-code', envelope, usedDir }),
      { code: 'bundled-credit/used' },
    )
  } finally {
    await rm(usedDir, { recursive: true, force: true })
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('credential refs are merged without dropping other records', () => {
  const src = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: keep-me',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-keep',
    '',
  ].join('\n')
  const out = mergeCredentialRefs(src, { OPENAI_API_KEY: 'sk-new-key' })
  assert.match(out, /secret: keep-me/)
  assert.match(out, /DEEPSEEK_API_KEY: sk-keep/)
  assert.match(out, /OPENAI_API_KEY: sk-new-key/)
  const again = mergeCredentialRefs(out, { OPENAI_API_KEY: 'sk-replaced' })
  assert.equal([...again.matchAll(/OPENAI_API_KEY:/g)].length, 1)
  assert.match(again, /OPENAI_API_KEY: sk-replaced/)
})

test('the default model patch prefers OpenAI and keeps other entries', () => {
  const src = [
    '- id: ui-settings-general',
    '  name: "@deepseek-ai/dsh-client-ui-settings-general"',
    '  config:',
    '    welcomeNoticeVersion: 2026-09-28.1',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: deepseek-account',
    '    model: deepseek-flash',
    '    reasoningEffort: high',
    '',
  ].join('\n')
  const out = mergeModelPatch(src)
  assert.match(out, /welcomeNoticeVersion: 2026-09-28.1/)
  assert.match(out, /id: llm-pi-ai/)
  assert.match(out, /apiKeyEnv: OPENAI_API_KEY/)
  assert.match(out, /provider: openai/)
  assert.match(out, /model: gpt-4o/)
  assert.equal(out.includes('deepseek-flash'), false)
  assert.equal([...out.matchAll(/id: agent-default-model/g)].length, 1)
})

test('unlock writes the key and a later spend over the cap removes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hbot-credit-'))
  try {
    const envelope = await sealSecret('sk-live-example', 'alpha-code')
    const { state, remaining } = await unlockCredit({ dataDir: dir, passphrase: 'alpha-code', envelope, now: new Date('2026-11-10T10:00:00Z') })
    assert.equal(state.unlocked, true)
    assert.equal(remaining, CREDIT_LIMIT_USD)
    const cred = await readFile(join(dir, '.credentials.yaml'), 'utf8')
    assert.match(cred, /OPENAI_API_KEY: sk-live-example/)
    const patch = await readFile(join(dir, 'profiles', 'ds-bot', 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /provider: openai/)
    assert.match(patch, /model: gpt-4o/)

    const after = recordUsage(dir, { model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000 })
    assert.equal(after.spentUsd, 12.5)
    assert.equal(after.exhausted, false)
    const done = recordUsage(dir, { model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000 })
    assert.equal(done.exhausted, true)
    assert.equal(remainingUsd(done), 0)
    const credAfter = await readFile(join(dir, '.credentials.yaml'), 'utf8')
    assert.equal(credAfter.includes('OPENAI_API_KEY'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cost estimates use a conservative fallback for unknown models', () => {
  const known = estimateCostUsd({ model: 'openai/gpt-4o-mini', inputTokens: 1_000_000, outputTokens: 0 })
  assert.equal(known, 0.15)
  const unknown = estimateCostUsd({ model: 'mystery-model', inputTokens: 1_000_000, outputTokens: 0 })
  assert.equal(unknown, 5)
})

test('spend is stored in the data directory, not in the envelope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hbot-credit-'))
  try {
    writeState(dir, { unlocked: true, spentUsd: 1, exhausted: false })
    const next = addSpend(dir, 2.25)
    assert.equal(next.spentUsd, 3.25)
    assert.equal(readState(dir).spentUsd, 3.25)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
