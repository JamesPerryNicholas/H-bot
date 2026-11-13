// Color mode: light, dark, or follow the system. DSH's theme service owns the
// durable preference and paints body[data-ds-dark-theme]; the desktop shell
// mirrors data-ds-theme-source into Electron nativeTheme, including the caption.

export const COLOR_MODES = Object.freeze(['system', 'light', 'dark'])
export const DEFAULT_COLOR_MODE = 'system'
export const COLOR_MODE_OPTIONS = Object.freeze([
  ['system', 'Follow system'],
  ['light', 'Light appearance'],
  ['dark', 'Dark appearance'],
])

export function colorModeOf(value) {
  return COLOR_MODES.includes(value) ? value : DEFAULT_COLOR_MODE
}

// The palette the UI should use, given a preference and whether the OS is dark.
export function resolvedColorScheme(preference, systemDark) {
  const mode = colorModeOf(preference)
  if (mode === 'light') return 'light'
  if (mode === 'dark') return 'dark'
  return systemDark ? 'dark' : 'light'
}

// Value published on the root for the host shell. system only when following the OS;
// a fixed light or dark preference publishes that scheme.
export function themeSourceOf(preference) {
  const mode = colorModeOf(preference)
  return mode === 'system' ? 'system' : mode
}

export function colorModeSource(theme, onChange) {
  return {
    getSnapshot: () => colorModeOf(theme?.getTheme?.()?.preference),
    subscribe: (listener) => {
      if (typeof onChange !== 'function') return () => {}
      const off = onChange(listener)
      return typeof off === 'function' ? off : () => {}
    },
  }
}

export function bindColorMode(theme, onChange) {
  return {
    colorMode: colorModeSource(theme, onChange),
    setColorMode: (id) => { theme?.setTheme?.(colorModeOf(id)) },
  }
}
