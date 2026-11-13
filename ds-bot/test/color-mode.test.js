import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  COLOR_MODE_OPTIONS, COLOR_MODES, DEFAULT_COLOR_MODE,
  bindColorMode, colorModeOf, colorModeSource, resolvedColorScheme, themeSourceOf,
} from '../src/client/color-mode.js'

test('the three color modes are follow system, light, and dark', () => {
  assert.deepEqual([...COLOR_MODES], ['system', 'light', 'dark'])
  assert.deepEqual(COLOR_MODE_OPTIONS.map(([id]) => id), ['system', 'light', 'dark'])
  assert.equal(DEFAULT_COLOR_MODE, 'system')
})

test('an unknown or missing preference falls back to follow system', () => {
  assert.equal(colorModeOf('system'), 'system')
  assert.equal(colorModeOf('light'), 'light')
  assert.equal(colorModeOf('dark'), 'dark')
  assert.equal(colorModeOf('moonlight'), 'system')
  assert.equal(colorModeOf(undefined), 'system')
  assert.equal(colorModeOf(null), 'system')
})

test('follow system uses the OS scheme; light and dark stay fixed', () => {
  assert.equal(resolvedColorScheme('system', false), 'light')
  assert.equal(resolvedColorScheme('system', true), 'dark')
  assert.equal(resolvedColorScheme('light', true), 'light')
  assert.equal(resolvedColorScheme('dark', false), 'dark')
  assert.equal(resolvedColorScheme('paper', true), 'dark')
})

test('the host theme source is system only when following the OS', () => {
  assert.equal(themeSourceOf('system'), 'system')
  assert.equal(themeSourceOf('light'), 'light')
  assert.equal(themeSourceOf('dark'), 'dark')
  assert.equal(themeSourceOf('unknown'), 'system')
})

function fakeTheme(initial = 'system') {
  let preference = initial
  const listeners = new Set()
  return {
    preferenceOf: () => preference,
    getTheme: () => ({ preference }),
    setTheme: (id) => {
      preference = id
      for (const listener of [...listeners]) listener({ preference })
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

test('the bound setting reads, writes, and persists the preference on the theme service', () => {
  const theme = fakeTheme('system')
  const bound = bindColorMode(theme, theme.onChange)
  assert.equal(bound.colorMode.getSnapshot(), 'system')
  bound.setColorMode('dark')
  assert.equal(theme.preferenceOf(), 'dark')
  assert.equal(bound.colorMode.getSnapshot(), 'dark')
  bound.setColorMode('light')
  assert.equal(theme.preferenceOf(), 'light')
  bound.setColorMode('system')
  assert.equal(theme.preferenceOf(), 'system')
  bound.setColorMode('neon')
  assert.equal(theme.preferenceOf(), 'system')
})

test('follow-system subscribers hear an OS theme change; a fixed preference does not flip the stored choice', () => {
  const theme = fakeTheme('system')
  const bound = bindColorMode(theme, theme.onChange)
  const seen = []
  const off = bound.colorMode.subscribe(snapshot => seen.push(snapshot.preference ?? bound.colorMode.getSnapshot()))
  // An OS flip republishes the same preference; the resolved scheme changes outside this store.
  theme.setTheme('system')
  assert.deepEqual(seen, ['system'])
  assert.equal(resolvedColorScheme(bound.colorMode.getSnapshot(), true), 'dark')
  assert.equal(themeSourceOf(bound.colorMode.getSnapshot()), 'system')
  bound.setColorMode('light')
  assert.deepEqual(seen, ['system', 'light'])
  assert.equal(resolvedColorScheme(bound.colorMode.getSnapshot(), true), 'light')
  off()
  bound.setColorMode('dark')
  assert.deepEqual(seen, ['system', 'light'])
})

test('a missing theme service still reports follow system and does not throw on write', () => {
  const bound = bindColorMode(undefined, undefined)
  assert.equal(bound.colorMode.getSnapshot(), 'system')
  bound.setColorMode('dark')
  assert.equal(bound.colorMode.getSnapshot(), 'system')
  const source = colorModeSource(undefined, undefined)
  assert.equal(source.getSnapshot(), 'system')
  assert.equal(typeof source.subscribe(() => {}), 'function')
  source.subscribe(() => {})()
})
