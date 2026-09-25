/**
 * Uygulama kısayolları. Terminal odaktayken de çalışırlar; bu yüzden yalnız
 * kabuk ve ajan CLI'larının pratikte kullanmadığı birleşimler seçildi
 * (GNOME Terminal'in sekme kısayollarıyla aynı aile). Eşleşen tuş PTY'ye gitmez.
 */
export type AppShortcut =
  | { kind: 'palette' }
  | { kind: 'jump'; index: number }
  | { kind: 'cycle'; delta: 1 | -1 }
  | { kind: 'new-session' }
  | { kind: 'new-tab' }
  | { kind: 'close-tab' }
  | { kind: 'move-tab'; delta: 1 | -1 }
  | { kind: 'maximize' }
  | { kind: 'sidebar' }

export interface KeyLike {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export function appShortcut(event: KeyLike, inTerminal: boolean): AppShortcut | null {
  const { key, code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta } = event
  const mod = ctrl || meta
  // Ctrl+K kabukta satır silmedir; terminal dışında paleti açar, terminalde Ctrl+Shift+P kullanılır.
  if (mod && shift && !alt && code === 'KeyP') return { kind: 'palette' }
  if (mod && !shift && !alt && code === 'KeyK' && !inTerminal) return { kind: 'palette' }
  if (alt && !mod && !shift && /^Digit[1-9]$/.test(code)) return { kind: 'jump', index: Number(code.slice(5)) - 1 }
  if (ctrl && !alt && !meta && !shift && (key === 'PageDown' || key === 'PageUp')) return { kind: 'cycle', delta: key === 'PageDown' ? 1 : -1 }
  // GNOME Terminal gibi: Ctrl+Shift+PgUp/PgDn sekmeyi sola/sağa taşır.
  if (ctrl && shift && !alt && !meta && (key === 'PageDown' || key === 'PageUp')) return { kind: 'move-tab', delta: key === 'PageDown' ? 1 : -1 }
  if (mod && shift && !alt && code === 'KeyN') return { kind: 'new-session' }
  // GNOME Terminal gibi: Ctrl+Shift+T yeni sekme, Ctrl+Shift+W sekmeyi kapatır (oturum sürer).
  if (mod && shift && !alt && code === 'KeyT') return { kind: 'new-tab' }
  if (mod && shift && !alt && code === 'KeyW') return { kind: 'close-tab' }
  if (mod && shift && !alt && key === 'Enter') return { kind: 'maximize' }
  if (mod && shift && !alt && code === 'KeyB') return { kind: 'sidebar' }
  return null
}

/** Kısayol ipucu metni; menü ve paletteki etiketlerle aynı yazım. */
export const SHORTCUT_LABELS = {
  palette: 'Ctrl+Shift+P',
  jump: 'Alt+1…9',
  cycle: 'Ctrl+PgUp / PgDn',
  newSession: 'Ctrl+Shift+N',
  newTab: 'Ctrl+Shift+T',
  closeTab: 'Ctrl+Shift+W',
  moveTab: 'Ctrl+Shift+PgUp / PgDn',
  maximize: 'Ctrl+Shift+Enter',
  sidebar: 'Ctrl+Shift+B',
} as const
