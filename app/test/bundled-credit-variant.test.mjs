import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { creditStatus, loadOpenWrap, loadVariant, sealSecrets, unlockCredit, unlockOpenCredit } from '../src/bundled-credit.mjs'

const srcDir = dirname(fileURLToPath(new URL('../src/bundled-credit.mjs', import.meta.url)))

test('open and unlock editions do not share credit state', async () => {
  const envelope = await sealSecrets('sk-shared-key', ['alpha-code', 'open-wrap-code'])
  const first = await mkdtemp(join(tmpdir(), 'hbot-unlock-'))
  const second = await mkdtemp(join(tmpdir(), 'hbot-open-'))
  try {
    await unlockCredit({ dataDir: first, passphrase: 'alpha-code', envelope, once: true })
    await unlockCredit({ dataDir: second, passphrase: 'open-wrap-code', envelope, once: false })
    assert.equal(creditStatus(first).unlocked, true)
    assert.equal(creditStatus(second).unlocked, true)
    assert.notEqual(first, second)
  } finally {
    await rm(first, { recursive: true, force: true })
    await rm(second, { recursive: true, force: true })
  }
})

test('an open-edition wrap can be reused after a wipe, unlike a one-time code', async () => {
  const envelope = await sealSecrets('sk-shared-key', ['once-code', 'wrap-code'])
  const onceDir = await mkdtemp(join(tmpdir(), 'hbot-once-'))
  const wrapDir = await mkdtemp(join(tmpdir(), 'hbot-wrap-'))
  const againDir = await mkdtemp(join(tmpdir(), 'hbot-wrap2-'))
  const usedDir = await mkdtemp(join(tmpdir(), 'hbot-used-'))
  try {
    await unlockCredit({ dataDir: onceDir, passphrase: 'once-code', envelope, usedDir, once: true })
    await assert.rejects(
      () => unlockCredit({ dataDir: againDir, passphrase: 'once-code', envelope, usedDir, once: true }),
      { code: 'bundled-credit/used' },
    )
    await unlockCredit({ dataDir: wrapDir, passphrase: 'wrap-code', envelope, usedDir, once: false })
    await unlockCredit({ dataDir: againDir, passphrase: 'wrap-code', envelope, usedDir, once: false })
    assert.equal(creditStatus(againDir).unlocked, true)
  } finally {
    await rm(onceDir, { recursive: true, force: true })
    await rm(wrapDir, { recursive: true, force: true })
    await rm(againDir, { recursive: true, force: true })
    await rm(usedDir, { recursive: true, force: true })
  }
})
