// Original H bot mark: a folded, forward-leaning H with two eyes on a blue tile.
// npm run icon regenerates the SVG, PNG, Windows ICO and monochrome tray marks.
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAND_COLOR as BLUE, iconSvg, traySvg } from '../../ds-bot/src/shared/brand.js'

const sharp = createRequire(import.meta.url)('sharp')
const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
const ICO_SIZES = [16, 20, 24, 32, 36, 40, 48, 64, 72, 96, 128, 256]
const TRAY_SIZES = [16, 20, 24, 32]
function icoFile(images) {
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index
    head.writeUInt8(size >= 256 ? 0 : size, at)
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(png.length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([head, ...images.map(image => image.png)])
}

const pngOf = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()
const icons = await Promise.all(ICO_SIZES.map(async size => ({ size, png: await pngOf(iconSvg(0.94), size) })))
const trays = await Promise.all(TRAY_SIZES.map(async size => ({ size, png: await pngOf(traySvg(BLUE), size) })))
const files = {
  'icon.svg': iconSvg(),
  'icon.png': await pngOf(iconSvg(), 1024),
  'icon.ico': icoFile(icons),
  'tray.svg': traySvg(BLUE),
  'tray.ico': icoFile(trays),
  'tray.png': await pngOf(traySvg(BLUE), 24),
  'trayTemplate.png': await pngOf(traySvg('#000000'), 16),
  'trayTemplate@2x.png': await pngOf(traySvg('#000000'), 32),
}
mkdirSync(assets, { recursive: true })
for (const [name, data] of Object.entries(files)) writeFileSync(join(assets, name), data)
console.log('icon: wrote H bot application and tray icons')
