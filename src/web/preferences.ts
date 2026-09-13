import { useSyncExternalStore, type CSSProperties } from 'react'
export interface Preferences { restore: boolean; notifications: boolean; previews: boolean; compact: boolean; colors: Record<string, string> }
const defaults: Preferences = { restore: true, notifications: false, previews: true, compact: true, colors: {} }
const KEY = 'agentdeck.preferences.v1'
function read(): Preferences {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const result = { ...defaults, colors: {} as Record<string, string> }
    for (const key of ['restore', 'notifications', 'previews', 'compact'] as const) if (typeof raw[key] === 'boolean') result[key] = raw[key]
    for (const [id, color] of Object.entries(raw.colors ?? {})) if (typeof color === 'string' && /^#[a-f0-9]{6}$/i.test(color)) result.colors[id] = color
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
