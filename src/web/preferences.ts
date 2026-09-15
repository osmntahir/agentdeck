import { useSyncExternalStore, type CSSProperties } from 'react'
export const THEMES = { graphite: { label: 'Graphite', background: '#0e1116', foreground: '#d5dae2', cursor: '#9bb4ff' },
  midnight: { label: 'Midnight', background: '#101827', foreground: '#d6e2f5', cursor: '#7db9ff' },
  forest: { label: 'Forest', background: '#101b17', foreground: '#d5e5db', cursor: '#8ad6ab' },
  plum: { label: 'Plum', background: '#1b1422', foreground: '#e6d9ef', cursor: '#c9a2ef' } } as const
export type ThemeName = keyof typeof THEMES
export interface Preferences { theme: ThemeName; notifications: boolean; previews: boolean; compact: boolean; colors: Record<string, string>; terminalColors: Record<string, string> }
const defaults: Preferences = { theme: 'graphite', terminalColors: {}, notifications: true, previews: true, compact: true, colors: {} }
const KEY = 'agentdeck.preferences.v1'
function read(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const result = { ...defaults, colors: {} as Record<string, string>, terminalColors: {} as Record<string, string> }
    for (const key of ['notifications', 'previews', 'compact'] as const) if (typeof raw[key] === 'boolean') result[key] = raw[key]
    if (typeof raw.theme === 'string' && Object.hasOwn(THEMES, raw.theme)) result.theme = raw.theme as ThemeName
    for (const key of ['colors', 'terminalColors'] as const)
      for (const [id, color] of Object.entries(raw[key] ?? {})) if (typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color)) result[key][id] = color
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
export function projectStyle(id: string, preferences: Preferences): CSSProperties {
  return { '--project-color': preferences.colors[id] ?? '#9aaad4' } as CSSProperties
}

export function terminalStyle(session: { id: string; projectId: string }, preferences: Preferences): CSSProperties {
  return { '--project-color': preferences.terminalColors[session.id] ?? preferences.colors[session.projectId] ?? '#9aaad4' } as CSSProperties
}
