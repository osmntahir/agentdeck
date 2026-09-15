import { showDesktopNotification } from './notifications'
import { useEffect, useRef, useState } from 'react'
import type { StateResponse } from '../shared/types'
import type { Preferences } from './preferences'

export interface Notice { id: string; sessionId: string; title: string; detail: string }

/** Daemon olaylarını uygulama içi ve masaüstü bildirimlerine dönüştürür. */
export function useWorkspaceLifecycle(state: StateResponse, healthy: boolean, preferences: Preferences) {
  const previous = useRef<StateResponse | null>(null)
  const [notices, setNotices] = useState<Notice[]>([])

  useEffect(() => {
    if (!healthy || !state.daemonId) return
    const before = previous.current
    previous.current = state
    if (!preferences.notifications || before?.daemonId !== state.daemonId) return

    const emit = (notice: Notice) => {
      setNotices(items => [notice, ...items.filter(item => item.id !== notice.id)].slice(0, 20))
      void showDesktopNotification(notice).catch(error => console.error('Masaüstü bildirimi gösterilemedi:', error))
    }

    for (const session of state.sessions) {
      const old = before.sessions.find(candidate => candidate.id === session.id)
      if (session.lifecycle === 'exited' && old?.lifecycle === 'live' && old.runId === session.runId) {
        const detail = session.exitCode === 0
          ? 'İş bitti'
          : session.exitCode !== null
            ? `İş hata ile bitti · çıkış kodu ${session.exitCode}`
            : session.exitSignal !== null
              ? `Terminal sonlandı · sinyal ${session.exitSignal}`
              : 'Terminal sonlandı'
        emit({ id: `${session.id}:${session.runId}:exit`, sessionId: session.id, title: session.name, detail })
      }

      if (session.attention && old?.attention?.detectedAt !== session.attention.detectedAt) {
        const detail = session.attention.kind === 'approval'
          ? 'İzin veya onay bekliyor'
          : `Yanıt bekliyor · ${session.attention.message}`
        emit({
          id: `${session.id}:${session.runId}:attention:${session.attention.detectedAt}`,
          sessionId: session.id,
          title: `${session.name} · müdahale gerekli`,
          detail,
        })
      }
    }

    for (const [sessionId, terminal] of Object.entries(state.terminals ?? {})) {
      if (!terminal.failure || before.terminals?.[sessionId]?.failure?.code === terminal.failure.code) continue
      const session = state.sessions.find(candidate => candidate.id === sessionId)
      if (!session) continue
      emit({
        id: `${sessionId}:${session.runId}:terminal:${terminal.failure.code}`,
        sessionId,
        title: `${session.name} · terminal hatası`,
        detail: terminal.failure.message,
      })
    }
  }, [state, healthy, preferences.notifications])

  const clearNotices = () => setNotices([])
  const dismissNotice = (id: string) => setNotices(items => items.filter(item => item.id !== id))
  return { notices, clearNotices, dismissNotice }
}
