import { useEffect, useMemo, useRef } from 'react'
import {
  acknowledgeActive, expandActiveIds, playUnreadSound, shouldPlayUnreadSound, syncUnreadBadge,
  unreadSummary, visibleCompletionIds,
} from './unread-notify.js'

export function useUnreadAlerts({
  useSessions, useSessionStatus, markedUnread, extraActiveIds = [], roster, setBadge, play = playUnreadSound,
} = {}) {
  const statusBits = useSessionStatus
    ? useSessionStatus(map => JSON.stringify([...map].map(([id, status]) => [
      id,
      status?.completionUnread === true ? 1 : 0,
      status?.pendingInteraction !== undefined ? 1 : 0,
    ])))
    : '[]'
  const statuses = useMemo(
    () => JSON.parse(statusBits || '[]').map(([id, completion, pending]) => [id, {
      completionUnread: completion === 1,
      pendingInteraction: pending === 1 ? true : undefined,
    }]),
    [statusBits],
  )
  const sessionBits = useSessions
    ? useSessions(list => JSON.stringify({
      active: Object.entries(list.byId ?? {})
        .filter(([, session]) => (session?.retainedBy?.mainView ?? 0) > 0)
        .map(([id]) => id),
      sessions: Object.fromEntries(Object.entries(list.byId ?? {}).map(([id, session]) => [id, {
        updatedAt: session?.updatedAt ?? 0,
        parentId: session?.parentId ?? session?.parentSessionId ?? session?.rootSessionId ?? null,
      }])),
    }))
    : '{"active":[],"sessions":{}}'
  const parsedSessions = useMemo(() => JSON.parse(sessionBits || '{"active":[],"sessions":{}}'), [sessionBits])
  const extraKey = Array.isArray(extraActiveIds) ? extraActiveIds.join(',') : ''
  const sessions = parsedSessions.sessions ?? {}
  const stamps = useMemo(() => Object.fromEntries(Object.entries(sessions).map(([id, row]) => [id, row?.updatedAt ?? 0])), [sessionBits])
  const activeIds = useMemo(
    () => expandActiveIds({
      activeIds: [...(parsedSessions.active ?? []), ...(extraActiveIds ?? [])],
      roster,
      sessions,
    }),
    [sessionBits, extraKey, roster],
  )
  const ackedRef = useRef({})
  const acked = acknowledgeActive(ackedRef.current, { statuses, activeIds, stamps })
  ackedRef.current = acked
  const summary = unreadSummary({ statuses, marked: markedUnread, activeIds, acked, stamps })
  const unreadIncoming = useMemo(() => {
    const map = {}
    for (const id of visibleCompletionIds({ statuses, activeIds, acked, stamps })) map[id] = true
    return map
  }, [statusBits, sessionBits, extraKey, acked, summary.incoming])
  const prev = useRef(null)
  const lastPlayed = useRef(0)
  useEffect(() => {
    const badge = setBadge ?? globalThis.dsBotApp?.setUnreadBadge
    syncUnreadBadge(summary.total, badge)
    const now = Date.now()
    if (shouldPlayUnreadSound({ previous: prev.current, next: summary, now, lastPlayedAt: lastPlayed.current })) {
      play()
      lastPlayed.current = now
    }
    prev.current = summary
  }, [summary.total, summary.incoming, setBadge, play])
  return { summary, unreadIncoming, activeIds }
}
