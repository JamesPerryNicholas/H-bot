// Writes the generated blocks of the start page in src/start from the plugin's client modules
// in ../ds-bot (read only, as scripts/icon.mjs does):
// - start.html, between <!-- whale --> markers: the H bot mark, with the motion anchors
//   kept for saved startup and hand-off states.
// - start.css, between /* tokens */ markers: the DeepSeek theme's light and dark colors.
// - start.css, between /* springs */ markers: motion.js's springs as linear() curves.
// - ../page-card.css, between the same two markers: the same colors and springs, scoped to the
//   card that the team window shows in place of a message box, so that the page's own are kept.
// Usage: node scripts/start-assets.mjs [--check]   (--check exits 1 when a block is stale and
// writes nothing)
import { readFileSync, writeFileSync } from 'node:fs'
import { characterMarkup, MASK_ID } from '../../ds-bot/src/client/characters.js'
import { INKS } from '../../ds-bot/src/client/inks.js'
import { allThemes, themeCss } from '../../ds-bot/src/client/themes.js'

const client = new URL('../../ds-bot/src/client/', import.meta.url)
const page = new URL('../src/start/', import.meta.url)

const THEME_TOKENS = ['--bt-main', '--bt-card', '--bt-ink', '--bt-ink-2', '--bt-line', '--bt-line-2', '--bt-hover', '--bt-accent', '--bt-accent-ink']
// The status colors are the same in both modes; the plugin's base sheet defines them.
const BASE_TOKENS = ['--bt-green', '--bt-danger']
const SPRINGS = ['shape', 'tap', 'pop', 'stretch', 'list']
// The layer of the team window's card (preload.cjs).
const CARD_SCOPE = '.dsb-card-layer'

// Keep the motion director's anchors; the retired whale tail now has no artwork.
function rig() {
  const mark = characterMarkup('whale', 'deepseek').replaceAll(MASK_ID, 'st-eyes')
    .replace('<g class="bt-gaze">', '<g id="gaze" class="bt-gaze">')
    .replace('<g class="bt-eyes" fill="#000">', '<g id="eye-pair" class="bt-eyes" fill="#000">')
  return '<svg class="whale-svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g id="tail"></g><g id="torso">' + mark + '</g></svg>'
}

const rules = css => [...css.matchAll(/\{([^}]*)\}/gu)].map(([, body]) => new Map(body.split(';').filter(Boolean).map(item => item.split(/:(.*)/su).slice(0, 2))))
function pick(vars, names, from) {
  return names.map((name) => {
    if (!vars.has(name)) throw new Error(`${from} no longer sets ${name}`)
    return `${name}:${vars.get(name)}`
  }).join(';')
}

function tokens(scope = ':root') {
  const [light, dark] = rules(themeCss(allThemes().deepseek))
  const base = readFileSync(new URL('styles.js', client), 'utf8').match(/^body\{(--bt-[^}]*)\}$/mu)
  if (!base) throw new Error('styles.js: the base body rule was not found')
  const [ink, inkDark] = INKS.deepseek
  return [
    '/* Generated from the DeepSeek theme in ds-bot/src/client/themes.js, inks.js and styles.js by scripts/start-assets.mjs; do not edit. */',
    `${scope}{color-scheme:light dark;${pick(light, THEME_TOKENS, 'themeCss')};--bt-ink-deepseek:${ink};${pick(rules(`{${base[1]}}`)[0], BASE_TOKENS, 'styles.js')}}`,
    `@media (prefers-color-scheme:dark){${scope}{${pick(dark, THEME_TOKENS, 'themeCss')};--bt-ink-deepseek:${inkDark}}}`,
  ]
}

// motion.js imports React for its hooks; its springs are plain arithmetic, so the module runs
// here with the React names stubbed out.
async function motion() {
  const source = readFileSync(new URL('motion.js', client), 'utf8')
  const imports = source.match(/^import .*$/gmu) ?? []
  const react = imports.length === 1 ? imports[0].match(/^import \{([^}]*)\} from 'react'\r?$/u) : null
  if (!react) throw new Error('motion.js: expected its only import to be from react')
  const stub = `const {${react[1].replaceAll(' as ', ': ')}} = {}`
  return import(`data:text/javascript,${encodeURIComponent(source.replace(imports[0], stub))}`)
}

async function springs(scope = ':root') {
  const curves = await motion()
  return [
    '/* Generated from ds-bot/src/client/motion.js by scripts/start-assets.mjs; do not edit. */',
    `${scope} {`,
    ...SPRINGS.flatMap((name) => {
      const curve = curves[`SPRING_${name.toUpperCase()}`]
      if (!curve) throw new Error(`motion.js no longer exports SPRING_${name.toUpperCase()}`)
      return [`  --spring-${name}: ${curve.easing};`, `  --spring-${name}-ms: ${curve.duration}ms;`]
    }),
    '}',
  ]
}

// Replaces what lies between the two markers; a block of lines takes the file's own line ends,
// which git may have turned into CRLF on checkout.
function between(text, open, close, block) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const body = Array.isArray(block) ? `${eol}${block.join(eol)}${eol}` : block
  const a = text.indexOf(open)
  const b = text.indexOf(close, a + open.length)
  if (a < 0 || b < 0) throw new Error(`markers ${open} ${close} not found`)
  return `${text.slice(0, a + open.length)}${body}${text.slice(b)}`
}

const files = {
  'start.html': html => between(html, '<!-- whale -->', '<!-- /whale -->', rig()),
  'start.css': async css => between(between(css, '/* tokens */', '/* /tokens */', tokens()), '/* springs */', '/* /springs */', await springs()),
  '../page-card.css': async css => between(between(css, '/* tokens */', '/* /tokens */', tokens(CARD_SCOPE)), '/* springs */', '/* /springs */', await springs(CARD_SCOPE)),
}
const check = process.argv.includes('--check')
const stale = []
for (const [name, generate] of Object.entries(files)) {
  const file = new URL(name, page)
  const text = readFileSync(file, 'utf8')
  const next = await generate(text)
  if (next === text) continue
  stale.push(name)
  if (!check) writeFileSync(file, next)
}
if (check && stale.length) {
  console.error(`start page: stale generated blocks in ${stale.join(', ')}; run node scripts/start-assets.mjs`)
  process.exit(1)
}
console.log(check ? 'start page: generated blocks are current' : stale.length ? `start page: wrote ${stale.join(', ')}` : 'start page: nothing to write')
