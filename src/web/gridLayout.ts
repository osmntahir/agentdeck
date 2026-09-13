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

export function loadGridLayout(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const layout = parseGridLayoutJson(raw)
    if (!layout) {
      clearGridLayout()
      return null
    }
    return layout as SerializedDockview
  } catch {
    return null
  }
}

export function saveGridLayout(layout: SerializedDockview): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    // Kaydedilemeyen yerleşim yalnız bu açılışta kalır.
  }
}

export function clearGridLayout(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Depolama erişilemezse silinecek kayıt da yoktur.
  }
}

/** Kayıtlı yerleşimdeki oturumlar; grid açık değilken kenar çubuğu sayacı için okunur. */
export function savedGridSessionIds(): string[] {
  const panels = loadGridLayout()?.panels
  return panels && typeof panels === 'object' ? Object.keys(panels) : []
}
