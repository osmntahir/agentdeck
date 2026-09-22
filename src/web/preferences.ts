import { useSyncExternalStore, type CSSProperties } from 'react'
import type { ITheme } from '@xterm/xterm'

/** Terminallerin ortak ANSI paleti; tema yalnız zemin, metin ve imleci değiştirir. */
const ANSI: ITheme = {
  black: '#1c1f26', red: '#f0717a', green: '#7fd49a', yellow: '#eec47a', blue: '#7aa7ff', magenta: '#c49bff', cyan: '#6fd2d8', white: '#c9ced8',
  brightBlack: '#5d6474', brightRed: '#ff8f96', brightGreen: '#9de6b3', brightYellow: '#f7d898', brightBlue: '#9cc0ff', brightMagenta: '#d9b8ff', brightCyan: '#94e3e8', brightWhite: '#f2f4f8',
}
export const THEMES = {
  graphite: { label: 'Graphite', swatch: '#8b9cff', terminal: { ...ANSI, background: '#0b0c0f', foreground: '#dfe2ea', cursor: '#aab6ff', cursorAccent: '#0b0c0f', selectionBackground: '#3a4270aa' } },
  midnight: { label: 'Midnight', swatch: '#5eb1ff', terminal: { ...ANSI, background: '#0a111d', foreground: '#dbe6f7', cursor: '#7dc0ff', cursorAccent: '#0a111d', selectionBackground: '#274a7aaa' } },
  forest: { label: 'Forest', swatch: '#6fd49c', terminal: { ...ANSI, background: '#0a1210', foreground: '#dbe9e0', cursor: '#8be0b0', cursorAccent: '#0a1210', selectionBackground: '#2c5a44aa' } },
  plum: { label: 'Plum', swatch: '#c79bff', terminal: { ...ANSI, background: '#120d18', foreground: '#ebdff4', cursor: '#d4afff', cursorAccent: '#120d18', selectionBackground: '#5a3c78aa' } },
} as const satisfies Record<string, { label: string; swatch: string; terminal: ITheme }>
export type ThemeName = keyof typeof THEMES
export interface Preferences {
  theme: ThemeName
  notifications: boolean
  previews: boolean
  compact: boolean
  colors: Record<string, string>
  terminalColors: Record<string, string>
  /** Projede en son seçilen program (preset etiketi); yeni oturum bununla açılır. */
  lastProgram: Record<string, string>
}
const defaults: Preferences = { theme: 'graphite', terminalColors: {}, notifications: true, previews: true, compact: true, colors: {}, lastProgram: {} }
const KEY = 'agentdeck.preferences.v1'
function read(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const result: Preferences = { ...defaults, colors: {}, terminalColors: {}, lastProgram: {} }
    for (const key of ['notifications', 'previews', 'compact'] as const) if (typeof raw[key] === 'boolean') result[key] = raw[key]
    if (typeof raw.theme === 'string' && Object.hasOwn(THEMES, raw.theme)) result.theme = raw.theme as ThemeName
    for (const key of ['colors', 'terminalColors'] as const)
      for (const [id, color] of Object.entries(raw[key] ?? {})) if (typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color)) result[key][id] = color
    for (const [id, label] of Object.entries(raw.lastProgram ?? {})) if (typeof label === 'string' && label.length <= 80) result.lastProgram[id] = label
    return result
  } catch { return defaults }
}
let current = read()
const listeners = new Set<() => void>()
window.addEventListener('storage', e => { if (e.key === KEY) { current = read(); listeners.forEach(fn => fn()) } })
export function updatePreferences(change: Partial<Preferences>): void {
  const next = { ...current, ...change }
  localStorage.setItem(KEY, JSON.stringify(next))
  current = next; listeners.forEach(fn => fn())
}
export function usePreferences(): Preferences { return useSyncExternalStore(fn => { listeners.add(fn); return () => { listeners.delete(fn) } }, () => current) }

/** Rengi seçilmemiş projeler kimliklerinden türetilen ayırt edici bir renk alır. */
const PROJECT_PALETTE = ['#8b9cff', '#5ec8e5', '#6fd49c', '#f2b36b', '#f08aa6', '#b89cff', '#e6d26b', '#7fc4a8']
export function defaultProjectColor(id: string): string {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PROJECT_PALETTE[hash % PROJECT_PALETTE.length]!
}
export function projectColor(id: string, preferences: Preferences): string {
  return preferences.colors[id] ?? defaultProjectColor(id)
}
export function projectStyle(id: string, preferences: Preferences): CSSProperties {
  return { '--project-color': projectColor(id, preferences) } as CSSProperties
}

export function terminalStyle(session: { id: string; projectId: string }, preferences: Preferences): CSSProperties {
  return { '--project-color': preferences.terminalColors[session.id] ?? projectColor(session.projectId, preferences) } as CSSProperties
}
