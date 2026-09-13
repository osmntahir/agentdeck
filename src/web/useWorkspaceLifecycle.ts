import { useEffect, useRef, useState } from 'react'
import type { StateResponse } from '../shared/types'
import { recoveryLaunch } from '../shared/workspacePolicy'
import type { Preferences } from './preferences'
import * as api from './api'

export interface Notice { id: string; sessionId: string; title: string; detail: string }
export function useWorkspaceLifecycle(state: StateResponse, healthy: boolean, preferences: Preferences, refresh: () => Promise<unknown>) {
  const previous = useRef<StateResponse | null>(null)
  const recovering = useRef(false)
  const attempted = useRef(new Set<string>())
  const [notices, setNotices] = useState<Notice[]>([])
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null)
  useEffect(() => {
    if (!healthy || !state.daemonId) return
    const before = previous.current
    previous.current = state
    if (preferences.notifications && before?.daemonId === state.daemonId) {
      const ended = state.sessions.filter(session => session.lifecycle === 'exited' && before.sessions.some(old => old.id === session.id && old.runId === session.runId && old.lifecycle === 'live'))
      for (const session of ended) {
        const notice = { id: `${session.id}:${session.runId}`, sessionId: session.id, title: session.name, detail: `Terminal sonlandı${session.exitCode !== null ? ` · çıkış kodu ${session.exitCode}` : ''}` }
        setNotices(items => [notice, ...items.filter(item => item.id !== notice.id)].slice(0, 20))
        if ('Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
          try { const notification = new Notification(notice.title, { body: notice.detail, tag: notice.id }); notification.onclick = () => window.focus() }
          catch { /* Uygulama içi bildirim her durumda korunur. */ }
        }
      }
    }
  }, [state, healthy, preferences.notifications])
  useEffect(() => {
    if (!healthy || !state.daemonId || state.serviceError || !preferences.restore || recovering.current) return
    const candidates = state.sessions.filter(session => recoveryLaunch(session) && !attempted.current.has(`${state.daemonId}:${session.id}:${session.runId}`))
    if (!candidates.length) return
    recovering.current = true
    void (async () => {
      let restored = 0
      const failures: string[] = []
      for (const session of candidates) {
        const key = `${state.daemonId}:${session.id}:${session.runId}`
        attempted.current.add(key)
        try {
          // Sayfa yenilemesi, süre aşımından sonra aynı işi kendiliğinden tekrar etmesin.
          const saved = JSON.parse(localStorage.getItem('agentdeck.recovery.v1') ?? '{}')
          const ids: string[] = saved.daemonId === state.daemonId && Array.isArray(saved.ids) ? saved.ids : []
          if (ids.includes(key)) continue
          localStorage.setItem('agentdeck.recovery.v1', JSON.stringify({ daemonId: state.daemonId, ids: [...ids, key].slice(-256) }))
          const intent = recoveryLaunch(session)!
          await api.recoverSession(session, intent)
          restored++
        } catch (e) { failures.push(`${session.name}: ${(e as Error).message}`) }
      }
      if (restored || failures.length) setRecoveryMessage([
        restored ? `${restored} yarım kalan oturum aynı klasörde geri açıldı. Konuşma kimliği bilinmeyen ajanlarda seçiciden devam edin; ek presetler yeni konuşmayla açılır.` : '',
        ...failures,
      ].filter(Boolean).join(' '))
      recovering.current = false
      await refresh()
    })()
  }, [state, healthy, preferences.restore])
  return { notices, clearNotices: () => setNotices([]), recoveryMessage, dismissRecovery: () => setRecoveryMessage(null) }
}
