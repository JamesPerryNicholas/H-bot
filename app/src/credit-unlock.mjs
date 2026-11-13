// Bundled provider keys are no longer offered. Packages do not ship a key,
// and users enter their own. receiveUnlock stays so an old unlock card can
// still be dismissed without writing a key into the user's data.
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

export async function offerBundledCredit() {
  return { available: false, unlocked: false, exhausted: false, remaining: 0 }
}
