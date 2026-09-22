import { agentFor } from './agents'
import type { SessionView, StateResponse } from './types'

/**
 * Durum değişimlerinden bildirim olayları türetir. Karar saftır; teslimat
 * (görünen oturumu susturma, masaüstü/uygulama içi seçimi) istemcidedir.
 */
export type NoticeKind = 'attention' | 'quiet' | 'finished' | 'failed' | 'terminal'

export interface NoticeEvent {
  sessionId: string
  runId: string | null
  kind: NoticeKind
  title: string
  detail: string
}

/** Ajanın kesintisiz çıktı ürettiği dönem; çıktı durunca bir kez "sıra sizde olabilir" denir. */
export interface WorkSpan {
  runId: string | null
  since: number
}

/** Bu kadar süren çalışmadan sonra gelen sessizlik bildirilir; kısa yanıtlar gürültü yapmaz. */
export const WORK_MIN_MS = 10_000
/** Çıktı bu kadar durunca ajan çalışmayı bırakmış sayılır. */
export const QUIET_AFTER_MS = 6_000

function agentLabel(session: SessionView): string | null {
  return agentFor(session.foregroundAgent)?.label ?? null
}

export function detectNotices(before: StateResponse, after: StateResponse, spans: Map<string, WorkSpan>): NoticeEvent[] {
  const events: NoticeEvent[] = []
  const now = after.serverNow
  for (const session of after.sessions) {
    const old = before.sessions.find((candidate) => candidate.id === session.id)
    const sameRun = old?.runId === session.runId

    if (session.lifecycle === 'exited' && old?.lifecycle === 'live' && sameRun) {
      const failed = session.exitCode !== null && session.exitCode !== 0
      events.push({
        sessionId: session.id,
        runId: session.runId,
        kind: failed ? 'failed' : 'finished',
        title: session.name,
        detail: failed
          ? `Hata ile bitti · çıkış kodu ${session.exitCode}`
          : session.exitSignal !== null
            ? `Terminal sonlandı · sinyal ${session.exitSignal}`
            : 'İş bitti',
      })
    }

    // Aynı Run'daki dikkat anı bir kez bildirilir; istem yeniden çizilince tekrar etmez.
    if (session.lifecycle === 'live' && session.attention && !(sameRun && old?.attention)) {
      events.push({
        sessionId: session.id,
        runId: session.runId,
        kind: 'attention',
        title: session.name,
        detail: session.attention.kind === 'approval' ? 'Onayınızı bekliyor' : `Yanıtınızı bekliyor · ${session.attention.message}`,
      })
    }

    const agent = session.lifecycle === 'live' ? agentLabel(session) : null
    const span = spans.get(session.id)
    if (!agent || session.lastActivityAt === null || (span && span.runId !== session.runId)) {
      spans.delete(session.id)
      if (!agent || session.lastActivityAt === null) continue
    }
    const quietFor = now - session.lastActivityAt
    const current = spans.get(session.id)
    if (quietFor < QUIET_AFTER_MS) {
      if (!current) spans.set(session.id, { runId: session.runId, since: session.lastActivityAt })
      continue
    }
    if (!current) continue
    spans.delete(session.id)
    // Onay bekleyen ajan için ayrı bildirim zaten gider; sessizlik tamamlanma kanıtı değildir.
    if (session.lastActivityAt - current.since >= WORK_MIN_MS && !session.attention) {
      events.push({
        sessionId: session.id,
        runId: session.runId,
        kind: 'quiet',
        title: session.name,
        detail: `${agent} çıktıyı durdurdu · sıra sizde olabilir`,
      })
    }
  }

  for (const [sessionId, terminal] of Object.entries(after.terminals ?? {})) {
    if (!terminal.failure || before.terminals?.[sessionId]?.failure?.code === terminal.failure.code) continue
    const session = after.sessions.find((candidate) => candidate.id === sessionId)
    if (!session) continue
    events.push({ sessionId, runId: session.runId, kind: 'terminal', title: session.name, detail: `Terminal hatası · ${terminal.failure.message}` })
  }
  return events
}
