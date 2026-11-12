// Start-page offer for the bundled OpenAI credit. The passphrase never
// appears in logs; only a yes/no result is recorded.
import { creditStatus, loadEnvelope, loadVariant, unlockCredit, unlockOpenCredit } from './bundled-credit.mjs'

let pending

export function receiveUnlock(payload) {
  const settle = pending
  pending = undefined
  if (settle === undefined) return
  if (payload && payload.skip === true) {
    settle({ skip: true })
    return
  }
  const value = typeof payload?.value === 'string' ? payload.value : ''
  settle({ value })
}

function waitForUnlock() {
  return new Promise((resolve) => {
    pending = resolve
  })
}

export async function offerBundledCredit({ startWindow, dataDir, usedDir }) {
  let envelope
  try { envelope = loadEnvelope() } catch { return { available: false, unlocked: false, exhausted: false, remaining: 0 } }
  if (!envelope || !dataDir) return { available: false, unlocked: false, exhausted: false, remaining: 0 }
  const status = creditStatus(dataDir)
  if (status.unlocked) return status

  if (loadVariant() === 'open') {
    await unlockOpenCredit({ dataDir, envelope, usedDir })
    return creditStatus(dataDir)
  }

  let wrong = false
  let used = false
  for (;;) {
    startWindow.card({ kind: 'creditUnlock', wrong, used })
    const answer = await startWindow.asking(waitForUnlock())
    if (answer?.skip) {
      startWindow.card(undefined)
      return creditStatus(dataDir)
    }
    try {
      await unlockCredit({ dataDir, passphrase: answer?.value ?? '', envelope, usedDir })
      startWindow.card(undefined)
      return creditStatus(dataDir)
    } catch (error) {
      if (error?.code === 'bundled-credit/invalid') {
        wrong = true
        used = false
        continue
      }
      if (error?.code === 'bundled-credit/used') {
        used = true
        wrong = false
        continue
      }
      startWindow.card(undefined)
      throw error
    }
  }
}
