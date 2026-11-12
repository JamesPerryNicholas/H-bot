import { deflateSync } from 'node:zlib'

// Windows taskbar overlay and dock badge for unread conversations.
// The overlay art is original: a red disc with a short white count.

export function badgeCount(value) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : 0
}

export function badgeText(count) {
  const n = badgeCount(count)
  if (n <= 0) return ''
  if (n > 9) return '9+'
  return String(n)
}

export function badgeCaption(count) {
  const n = badgeCount(count)
  if (n <= 0) return ''
  return n === 1 ? '1 unread' : `${n} unread`
}

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const t = Buffer.from(type)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

// 5x7 digits and a plus, packed as rows of 5 bits (MSB is the left pixel).
const GLYPHS = {
  1: [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  2: [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  3: [0b01110, 0b10001, 0b00001, 0b00110, 0b00001, 0b10001, 0b01110],
  4: [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  5: [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110],
  6: [0b01110, 0b10000, 0b11110, 0b10001, 0b10001, 0b10001, 0b01110],
  7: [0b11111, 0b00001, 0b00010, 0b00100, 0b00100, 0b01000, 0b01000],
  8: [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  9: [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000],
}

const SIZE = 32
const RED = [226, 45, 53, 255]
const WHITE = [255, 255, 255, 255]

function put(rgba, x, y, color, scale = 1) {
  for (let dy = 0; dy < scale; dy++) {
    for (let dx = 0; dx < scale; dx++) {
      const px = x + dx
      const py = y + dy
      if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) continue
      const i = (py * SIZE + px) * 4
      rgba[i] = color[0]
      rgba[i + 1] = color[1]
      rgba[i + 2] = color[2]
      rgba[i + 3] = color[3]
    }
  }
}

function drawGlyph(rgba, glyph, originX, originY, scale) {
  for (let row = 0; row < 7; row++) {
    const bits = glyph[row]
    for (let col = 0; col < 5; col++) {
      if (bits & (1 << (4 - col))) put(rgba, originX + col * scale, originY + row * scale, WHITE, scale)
    }
  }
}

export function overlayPng(count) {
  const text = badgeText(count)
  const rgba = Buffer.alloc(SIZE * SIZE * 4)
  const cx = (SIZE - 1) / 2
  const cy = (SIZE - 1) / 2
  const radius = 14.5
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= radius * radius) put(rgba, x, y, RED)
    }
  }
  const scale = text.length > 1 ? 2 : 3
  const width = text.length * 5 * scale + (text.length - 1) * scale
  const height = 7 * scale
  let x = Math.round((SIZE - width) / 2)
  const y = Math.round((SIZE - height) / 2)
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (glyph) {
      drawGlyph(rgba, glyph, x, y, scale)
      x += 5 * scale + scale
    }
  }
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let row = 0; row < SIZE; row++) {
    raw[row * (SIZE * 4 + 1)] = 0
    rgba.copy(raw, row * (SIZE * 4 + 1) + 1, row * SIZE * 4, (row + 1) * SIZE * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function applyUnreadBadge({ app, nativeImage, window: win }, count, { flash = true } = {}) {
  const n = badgeCount(count)
  try { app?.setBadgeCount?.(n) } catch {}
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return n
  if (n <= 0) {
    try { win.setOverlayIcon?.(null, '') } catch {}
    try { win.flashFrame?.(false) } catch {}
    return n
  }
  try {
    const image = nativeImage.createFromBuffer(overlayPng(n))
    win.setOverlayIcon?.(image, badgeCaption(n))
  } catch {}
  if (flash && typeof win.isFocused === 'function' && !win.isFocused()) {
    try { win.flashFrame?.(true) } catch {}
  }
  return n
}
