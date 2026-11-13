import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { estimateCostUsd, isImageModel, noteBundledSpend } from '../src/host/bundled-credit-spend.mjs'

test('cost estimates still distinguish image models and token rates', () => {
  assert.equal(isImageModel('openai/gpt-image-2.6-sunburst'), true)
  assert.equal(isImageModel('gpt-4o'), false)
  const chat = estimateCostUsd({ model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000 })
  assert.equal(chat, 12.5)
})

test('spend past the old $20 mark does not exhaust or strip the official key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hbot-spend-'))
  try {
    await writeFile(join(dir, 'bundled-credit.json'), `${JSON.stringify({
      unlocked: true,
      spentUsd: 19.5,
      exhausted: false,
    }, null, 2)}\n`)
    await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  OPENAI_API_KEY: sk-test-key\n')
    const next = noteBundledSpend(dir, { costUsd: 2 })
    assert.equal(next.spentUsd, 21.5)
    assert.equal(next.exhausted, false)
    const cred = await readFile(join(dir, '.credentials.yaml'), 'utf8')
    assert.match(cred, /OPENAI_API_KEY: sk-test-key/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a historical exhausted flag does not block later spend or remove the key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hbot-spend-ex-'))
  try {
    await writeFile(join(dir, 'bundled-credit.json'), `${JSON.stringify({
      unlocked: true,
      spentUsd: 20,
      exhausted: true,
    }, null, 2)}\n`)
    await writeFile(join(dir, '.credentials.yaml'), 'version: 1\nrefs:\n  OPENAI_API_KEY: sk-test-key\n')
    const next = noteBundledSpend(dir, { model: 'gpt-4o', usage: { inputTokens: 1_000_000, outputTokens: 0 } })
    assert.equal(next.spentUsd, 22.5)
    assert.equal(next.exhausted, false)
    const cred = await readFile(join(dir, '.credentials.yaml'), 'utf8')
    assert.match(cred, /OPENAI_API_KEY: sk-test-key/)
    const saved = JSON.parse(await readFile(join(dir, 'bundled-credit.json'), 'utf8'))
    assert.equal(saved.exhausted, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})