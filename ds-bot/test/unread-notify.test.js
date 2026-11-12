import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  shouldClearMarkedUnread,
  isIncomingStatus,
  unreadSummary,
  shouldPlayUnreadSound,
  syncUnreadBadge,
  acknowledgeActive,
  visibleCompletionIds,
  expandActiveIds,
} from '../src/client/unread-notify.js'

test('marking the open conversation does not clear until it is opened again', () => {
  assert.equal(shouldClearMarkedUnread(true, true), false)
  assert.equal(shouldClearMarkedUnread(false, true), true)
  assert.equal(shouldClearMarkedUnread(true, false), false)
  assert.equal(shouldClearMarkedUnread(false, false), false)
})

test('incoming unread is a completed turn or a pending prompt, not a manual mark', () => {
  assert.equal(isIncomingStatus({ completionUnread: true }), true)
  assert.equal(isIncomingStatus({ pendingInteraction: { id: 'q' } }), true)
  assert.equal(isIncomingStatus({ running: true }), false)
  assert.equal(isIncomingStatus(undefined), false)
})

test('the badge counts unique incoming sessions and manual marks together', () => {
  const summary = unreadSummary({
    statuses: [
      ['writer', { completionUnread: true }],
      ['open', { completionUnread: true }],
      ['idle', { running: false }],
    ],
    marked: { writer: true, notes: true },
    activeIds: ['open'],
  })
  // open is viewed so its completion does not count; writer is both incoming and marked; notes is marked only.
  assert.deepEqual(summary, { total: 2, incoming: 1 })
})

test('opening a conversation acknowledges its completion unread, and leaving keeps it read', () => {
  const statuses = [['writer', { completionUnread: true }]]
  const stamps = { writer: 100 }
  const acked = acknowledgeActive({}, { statuses, activeIds: ['writer'], stamps })
  assert.deepEqual(acked, { writer: '100' })
  const whileOpen = unreadSummary({ statuses, marked: {}, activeIds: ['writer'], acked, stamps })
  const afterLeave = unreadSummary({ statuses, marked: {}, activeIds: [], acked, stamps })
  assert.deepEqual(whileOpen, { total: 0, incoming: 0 })
  assert.deepEqual(afterLeave, { total: 0, incoming: 0 })
  assert.deepEqual(visibleCompletionIds({ statuses, activeIds: [], acked, stamps }), [])
})

test('a later update on a previously read chat counts as new unread', () => {
  const statuses = [['writer', { completionUnread: true }]]
  const acked = acknowledgeActive({}, { statuses, activeIds: ['writer'], stamps: { writer: 100 } })
  const later = unreadSummary({ statuses, marked: {}, activeIds: [], acked, stamps: { writer: 200 } })
  assert.deepEqual(later, { total: 1, incoming: 1 })
  assert.deepEqual(visibleCompletionIds({ statuses, activeIds: [], acked, stamps: { writer: 200 } }), ['writer'])
})

test('a pending prompt still counts after the chat is left, and a manual mark on the open chat is not in the badge', () => {
  const pending = unreadSummary({
    statuses: [['q', { pendingInteraction: { id: 'ask' } }]],
    marked: {},
    activeIds: [],
  })
  assert.deepEqual(pending, { total: 1, incoming: 1 })
  const markedOpen = unreadSummary({
    statuses: [],
    marked: { writer: true },
    activeIds: ['writer'],
  })
  assert.deepEqual(markedOpen, { total: 0, incoming: 0 })
})

test('opening a group chat reads the room id, the current part, and earlier parts together', () => {
  const roster = { rooms: [{ id: 'room', sessionId: 'part-2' }] }
  const sessions = { 'part-2': { parentId: 'part-1', updatedAt: 200 }, 'part-1': { updatedAt: 100 } }
  const expanded = expandActiveIds({ activeIds: ['part-2'], roster, sessions })
  assert.equal(expanded.includes('room'), true)
  assert.equal(expanded.includes('part-1'), true)
  assert.equal(expanded.includes('part-2'), true)
  const statuses = [
    ['part-1', { completionUnread: true }],
    ['part-2', { completionUnread: true }],
  ]
  const stamps = { 'part-1': 100, 'part-2': 200 }
  const acked = acknowledgeActive({}, { statuses, activeIds: expanded, stamps })
  const whileOpen = unreadSummary({ statuses, marked: { room: true }, activeIds: expanded, acked, stamps })
  const afterLeave = unreadSummary({ statuses, marked: {}, activeIds: [], acked, stamps })
  assert.deepEqual(whileOpen, { total: 0, incoming: 0 })
  assert.deepEqual(afterLeave, { total: 0, incoming: 0 })
})

test('a shared root id does not treat every chat as the open one', () => {
  const sessions = {
    a: { parentId: null, rootSessionId: 'ws', updatedAt: 1 },
    b: { parentId: null, rootSessionId: 'ws', updatedAt: 2 },
  }
  const expanded = expandActiveIds({ activeIds: ['a'], sessions })
  assert.deepEqual([...expanded].sort(), ['a'])
  const statuses = [['b', { completionUnread: true }]]
  const acked = acknowledgeActive({}, { statuses, activeIds: expanded, stamps: { b: 2 } })
  assert.deepEqual(unreadSummary({ statuses, marked: {}, activeIds: expanded, acked, stamps: { b: 2 } }), { total: 1, incoming: 1 })
})

test('a sound plays only when incoming unread grows, not on the first snapshot or a manual mark', () => {
  const first = unreadSummary({ statuses: [], marked: {}, activeIds: [] })
  const marked = unreadSummary({ statuses: [], marked: { notes: true }, activeIds: [] })
  const incoming = unreadSummary({ statuses: [['writer', { completionUnread: true }]], marked: {}, activeIds: [] })
  assert.equal(shouldPlayUnreadSound({ previous: null, next: incoming, now: 1000, lastPlayedAt: 0 }), false)
  assert.equal(shouldPlayUnreadSound({ previous: first, next: marked, now: 1000, lastPlayedAt: 0 }), false)
  assert.equal(shouldPlayUnreadSound({ previous: first, next: incoming, now: 1000, lastPlayedAt: 0 }), true)
  assert.equal(shouldPlayUnreadSound({ previous: first, next: incoming, now: 1200, lastPlayedAt: 1000, gap: 800 }), false)
})

test('the desktop badge is a non-negative integer', () => {
  const sent = []
  syncUnreadBadge(3.7, n => sent.push(n))
  syncUnreadBadge(-2, n => sent.push(n))
  syncUnreadBadge(undefined, n => sent.push(n))
  assert.deepEqual(sent, [3, 0, 0])
})
