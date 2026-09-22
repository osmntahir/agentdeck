import { showDesktopNotification } from './notifications'
import { useEffect, useRef, useState } from 'react'
import type { StateResponse } from '../shared/types'
import { detectNotices, type NoticeKind, type WorkSpan } from '../shared/notices'
import type { Preferences } from './preferences'

export interface Notice {
  id: string
  sessionId: string
  kind: NoticeKind
  title: string
  detail: string
  at: number
  /** Uygulama öndeyken köşede kısa süre görünür; arka plandayken masaüstü bildirimi gider. */
  toast: boolean
}

/** Aynı oturum ve türde bu süre içinde ikinci bildirim gönderilmez. */
const COOLDOWN_MS = 20_000

function foreground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Daemon olaylarını bildirime dönüştürür. Kullanıcının o an baktığı oturum
 * bildirim üretmez; oturum başına tek kayıt tutulur ve açılınca okunmuş sayılıp kalkar.
 */
export function useWorkspaceLifecycle(state: StateResponse, healthy: boolean, preferences: Preferences, visibleIds: string[]) {
  const previous = useRef<StateResponse | null>(null)
  const spans = useRef(new Map<string, WorkSpan>())
  const lastSent = useRef(new Map<string, number>())
  const visible = useRef(visibleIds)
  visible.current = visibleIds
  const [notices, setNotices] = useState<Notice[]>([])
  const [focused, setFocused] = useState(foreground)

  useEffect(() => {
    const sync = () => setFocused(foreground())
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])

  // Görülen oturumun bildirimi okunmuş sayılır.
  useEffect(() => {
    if (!focused) return
    setNotices((items) => (items.some((n) => visibleIds.includes(n.sessionId)) ? items.filter((n) => !visibleIds.includes(n.sessionId)) : items))
  }, [focused, visibleIds.join(',')])

  useEffect(() => {
    if (!healthy || !state.daemonId) return
    const before = previous.current
    previous.current = state
    if (!before || before.daemonId !== state.daemonId) {
      spans.current.clear()
      return
    }
    const events = detectNotices(before, state, spans.current)

    // Kalkan dikkat ve silinen oturumun kaydı listeden düşer.
    setNotices((items) => {
      const next = items.filter((notice) => {
        const session = state.sessions.find((s) => s.id === notice.sessionId)
        return session && (notice.kind !== 'attention' || session.attention)
      })
      return next.length === items.length ? items : next
    })
    if (!preferences.notifications) return

    const now = Date.now()
    const front = foreground()
    for (const event of events) {
      if (front && visible.current.includes(event.sessionId)) continue
      const key = `${event.sessionId}:${event.kind}`
      if (now - (lastSent.current.get(key) ?? 0) < COOLDOWN_MS) continue
      lastSent.current.set(key, now)
      const notice: Notice = { ...event, id: `${key}:${now}`, at: now, toast: front }
      setNotices((items) => [notice, ...items.filter((item) => item.sessionId !== notice.sessionId)].slice(0, 20))
      if (!front) void showDesktopNotification(notice).catch((error) => console.error('Masaüstü bildirimi gösterilemedi:', error))
    }
  }, [state, healthy, preferences.notifications])

  const clearNotices = () => setNotices([])
  const dismissNotice = (id: string) => setNotices((items) => items.filter((item) => item.id !== id))
  return { notices, clearNotices, dismissNotice }
}
