// Manual "Mark as Unread" lasts until the conversation is opened again:
// only a transition from inactive to active clears it, so marking the
// conversation already on screen is visible until the user leaves and comes back.
export function shouldClearMarkedUnread(wasActive, active) {
  return active === true && wasActive !== true
}

export function isIncomingStatus(status) {
  return status?.completionUnread === true || status?.pendingInteraction !== undefined
}

export function isCompletionUnread(status) {
  return status?.completionUnread === true
}

export function isPendingStatus(status) {
  return status?.pendingInteraction !== undefined
}

function parentOf(id, sessions) {
  const row = sessions?.[id]
  const parent = row?.parentId ?? row?.parentSessionId
  // Only walk a real earlier part in the same session list. A shared workspace
  // or root id would otherwise mark every chat as the one being read.
  if (!parent || parent === id || sessions?.[parent] === undefined) return null
  return parent
}

function rootOf(id, sessions) {
  const seen = new Set()
  let cur = id
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const next = parentOf(cur, sessions)
    if (!next) break
    cur = next
  }
  return cur
}

function conversationGroups(roster) {
  const groups = []
  for (const bot of roster?.bots ?? []) {
    const ids = [bot.id, bot.sessionId, ...(bot.sessions ?? []), ...(bot.parts ?? [])].filter(Boolean)
    if (ids.length) groups.push(ids)
  }
  for (const room of roster?.rooms ?? []) {
    const ids = [room.id, room.sessionId, ...(room.sessions ?? []), ...(room.parts ?? [])].filter(Boolean)
    if (ids.length) groups.push(ids)
  }
  for (const agent of roster?.agents ?? []) {
    const ids = [agent.id, ...(agent.sessions ?? [])].filter(Boolean)
    if (ids.length) groups.push(ids)
  }
  return groups
}

// Opening any part of a chat — including a group's current session — should
// treat the whole conversation as the one being read: the room id, the current
// part, and earlier parts in the same chain.
export function expandActiveIds({ activeIds = [], roster, sessions = {} } = {}) {
  const ids = new Set((activeIds ?? []).filter(Boolean))
  if (ids.size === 0) return []
  let grew = true
  while (grew) {
    grew = false
    const roots = new Set([...ids].map(id => rootOf(id, sessions)))
    for (const id of Object.keys(sessions ?? {})) {
      if (roots.has(rootOf(id, sessions)) && !ids.has(id)) {
        ids.add(id)
        grew = true
      }
    }
    for (const group of conversationGroups(roster)) {
      if (group.some(id => ids.has(id))) {
        for (const id of group) {
          if (!ids.has(id)) {
            ids.add(id)
            grew = true
          }
        }
      }
    }
  }
  return [...ids]
}

// A stamp for a completion-unread so that opening the chat acknowledges
// this arrival, and a later update can count as new unread again.
export function completionStamp(status, updatedAt = 0) {
  if (!isCompletionUnread(status)) return null
  return `${Number(updatedAt) || 0}`
}

export function acknowledgeActive(acked = {}, { statuses = [], activeIds = [], stamps = {} } = {}) {
  const next = { ...acked }
  const statusMap = new Map(statuses)
  for (const id of activeIds) {
    const stamp = completionStamp(statusMap.get(id), stamps[id])
    if (stamp != null) next[id] = stamp
    else delete next[id]
  }
  return next
}

export function isAckedCompletion(id, status, acked, stamps = {}) {
  const stamp = completionStamp(status, stamps[id])
  return stamp != null && acked?.[id] === stamp
}

export function unreadSummary({ statuses = [], marked = {}, activeIds = [], acked = {}, stamps = {} } = {}) {
  const active = new Set(activeIds)
  const incoming = new Set()
  for (const [id, status] of statuses) {
    if (active.has(id)) continue
    if (isPendingStatus(status)) incoming.add(id)
    else if (isCompletionUnread(status) && !isAckedCompletion(id, status, acked, stamps)) incoming.add(id)
  }
  const marks = new Set(Object.entries(marked ?? {}).filter(([, on]) => on).map(([id]) => id).filter(id => !active.has(id)))
  const ids = new Set([...incoming, ...marks])
  return { total: ids.size, incoming: incoming.size }
}

export function visibleCompletionIds({ statuses = [], activeIds = [], acked = {}, stamps = {} } = {}) {
  const active = new Set(activeIds)
  const ids = []
  for (const [id, status] of statuses) {
    if (active.has(id)) continue
    if (isCompletionUnread(status) && !isAckedCompletion(id, status, acked, stamps)) ids.push(id)
  }
  return ids
}

export function shouldPlayUnreadSound({ previous, next, now, lastPlayedAt = 0, gap = 800 } = {}) {
  if (previous == null) return false
  if ((next?.incoming ?? 0) <= (previous.incoming ?? 0)) return false
  return now - lastPlayedAt >= gap
}

export function syncUnreadBadge(count, setBadge) {
  if (typeof setBadge !== 'function') return
  const n = Math.max(0, Math.floor(Number(count) || 0))
  setBadge(n)
}

let audioCtx

// A short original two-note chime. Playing is best-effort; the badge still updates
// if the context cannot start (some pages wait for a gesture).
export function playUnreadSound({ context } = {}) {
  const Ctor = context ?? globalThis.AudioContext ?? globalThis.webkitAudioContext
  if (typeof Ctor !== 'function') return
  try {
    audioCtx ??= new Ctor()
    const ctx = audioCtx
    const start = () => {
      const t0 = ctx.currentTime
      const chime = (at, freq, dur, peak) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, t0 + at)
        gain.gain.setValueAtTime(0.0001, t0 + at)
        gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.018)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(t0 + at)
        osc.stop(t0 + at + dur + 0.02)
      }
      chime(0, 784, 0.16, 0.28)
      chime(0.12, 1175, 0.26, 0.34)
    }
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      void ctx.resume().then(start, () => {})
    } else start()
  } catch {
    // ignore
  }
}
