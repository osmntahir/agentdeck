/** Grid yerleşimi istemcide tutulur; bu koruma portal açılmadan uygulanır. */

export const MAX_GRID_PANELS = 16
export const GRID_LAYOUT_TEXT_LIMIT = 1024 * 1024

/**
 * Kayıt 1 MiB'yi, 16 paneli veya panel/Session kimlik tutarlılığını aşarsa
 * null döner. Dockview'in derin şeması ayrıca fromJSON'da doğrulanır.
 */
export function parseGridLayoutJson(raw: string | null): { panels: Record<string, { id: string }> } | null {
  if (!raw || raw.length > GRID_LAYOUT_TEXT_LIMIT) return null
  try {
    const layout = JSON.parse(raw) as { panels?: unknown } | null
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return null
    const panels = layout.panels
    if (!panels || typeof panels !== 'object' || Array.isArray(panels)) return null
    const entries = Object.entries(panels as Record<string, unknown>)
    if (entries.length > MAX_GRID_PANELS) return null
    for (const [id, panel] of entries) {
      if (!panel || typeof panel !== 'object' || Array.isArray(panel)) return null
      const record = panel as { id?: unknown; contentComponent?: unknown; params?: { sessionId?: unknown } }
      if (record.id !== id || record.contentComponent !== 'terminal' || record.params?.sessionId !== id) return null
    }
    return layout as { panels: Record<string, { id: string }> }
  } catch {
    return null
  }
}
