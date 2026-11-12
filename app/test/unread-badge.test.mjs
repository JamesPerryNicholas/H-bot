import assert from 'node:assert/strict'
import { test } from 'node:test'
import { badgeCount, badgeText, badgeCaption, overlayPng, applyUnreadBadge } from '../src/unread-badge.mjs'

test('the overlay label caps at 9+', () => {
  assert.equal(badgeCount(0), 0)
  assert.equal(badgeCount(-4), 0)
  assert.equal(badgeText(1), '1')
  assert.equal(badgeText(9), '9')
  assert.equal(badgeText(12), '9+')
  assert.equal(badgeCaption(1), '1 unread')
  assert.equal(badgeCaption(12), '12 unread')
})

test('the overlay is a 32×32 PNG', () => {
  const png = overlayPng(3)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(png.length > 80)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  assert.equal(width, 32)
  assert.equal(height, 32)
  assert.equal(png[24], 8)
  assert.equal(png[25], 6)
})

test('the main process sets the dock count and a Windows overlay, and flashes only when unfocused', () => {
  const calls = []
  const image = { kind: 'overlay' }
  const win = {
    destroyed: false,
    focused: false,
    isDestroyed() { return this.destroyed },
    isFocused() { return this.focused },
    setOverlayIcon(icon, caption) { calls.push(['overlay', icon === null ? null : 'image', caption]) },
    flashFrame(on) { calls.push(['flash', on]) },
  }
  const app = { setBadgeCount(n) { calls.push(['badge', n]) } }
  const nativeImage = { createFromBuffer(buf) { assert.equal(buf[0], 137); return image } }
  applyUnreadBadge({ app, nativeImage, window: win }, 2)
  assert.deepEqual(calls, [['badge', 2], ['overlay', 'image', '2 unread'], ['flash', true]])
  calls.length = 0
  win.focused = true
  applyUnreadBadge({ app, nativeImage, window: win }, 2, { flash: true })
  assert.deepEqual(calls, [['badge', 2], ['overlay', 'image', '2 unread']])
  calls.length = 0
  applyUnreadBadge({ app, nativeImage, window: win }, 0)
  assert.deepEqual(calls, [['badge', 0], ['overlay', null, ''], ['flash', false]])
})
