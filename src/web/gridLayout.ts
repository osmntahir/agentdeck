import type { SerializedDockview } from 'dockview-react'
import { MAX_GRID_PANELS, parseGridLayoutJson } from '../shared/gridLayoutGuard'

export { MAX_GRID_PANELS }

/**
 * Terminal grid yerleşimi yalnız bu istemcide tutulur; daemon kaydına girmez.
 * Depolama okunamaz veya yazılamazsa grid bu açılışla sınırlı kalır.
 */
const KEY = 'agentdeck.terminalGrid.v1'

/** Kenar çubuğundan veya karttan sürüklenen oturumun veri türü. */
export const SESSION_DRAG_TYPE = 'application/x-agentdeck-session'

export function loadGridLayout(gridId = 'default'): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(layoutKey(gridId))
    if (!raw) return null
    const layout = parseGridLayoutJson(raw)
    if (!layout) {
      clearGridLayout(gridId)
      return null
    }
    return layout as SerializedDockview
  } catch {
    return null
  }
}

export function saveGridLayout(layout: SerializedDockview, gridId = 'default'): void {
  try {
    localStorage.setItem(layoutKey(gridId), JSON.stringify(layout))
  } catch {
    // Kaydedilemeyen yerleşim yalnız bu açılışta kalır.
  }
}

export function clearGridLayout(gridId = 'default'): void {
  try {
    localStorage.removeItem(layoutKey(gridId))
  } catch {
    // Depolama erişilemezse silinecek kayıt da yoktur.
  }
}

/** Kayıtlı yerleşimdeki oturumlar; grid açık değilken kenar çubuğu sayacı için okunur. */
export function savedGridSessionIds(gridId = 'default'): string[] {
  const panels = loadGridLayout(gridId)?.panels
  return panels && typeof panels === 'object' ? Object.keys(panels) : []
}

function layoutKey(id: string): string { return id === 'default' ? KEY : `${KEY}.${id}` }
export interface GridWorkspace { id: string; name: string }
const CATALOG = 'agentdeck.grids.v1'
export function loadGridWorkspaces(): GridWorkspace[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CATALOG) ?? 'null')
    if (Array.isArray(raw)) {
      const seen = new Set<string>()
      const grids = raw.filter((g): g is GridWorkspace => {
        if (!g || typeof g.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(g.id) || typeof g.name !== 'string' || !g.name.trim() || seen.has(g.id)) return false
        seen.add(g.id); return true
      })
      if (grids.length) return grids
    }
  } catch { /* Eski tek grid kaydı korunur. */ }
  return [{ id: 'default', name: 'Grid 1' }]
}
export function saveGridWorkspaces(grids: GridWorkspace[]): void {
  localStorage.setItem(CATALOG, JSON.stringify(grids))
}
