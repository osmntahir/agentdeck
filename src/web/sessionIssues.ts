import type { SessionView, StateResponse } from '../shared/types'
import { sessionWorkCli } from '../shared/sessionActions'

export const TRUST_NOTE = 'Ajan klasör güveni veya giriş onayı isteyebilir; terminalden tamamlayın.'

/** Güven notu oturum başına bir kez kapatılır; kayıt bu sekmenin ömrü kadar tutulur. */
export function trustKey(id: string): string {
  return `agentdeck.trustNote.${id}`
}

export function trustNoteDismissed(id: string): boolean {
  try { return sessionStorage.getItem(trustKey(id)) === '1' } catch { return false }
}

/**
 * Oturumun o an dikkat isteyen durumları: ayrıntı görünümünde şerit, sekmede
 * grup başlığındaki simge olarak gösterilir.
 */
export function sessionIssues(session: SessionView, state: StateResponse): { tone: 'error' | 'warn'; text: string }[] {
  const project = state.projects.find((p) => p.id === session.projectId)
  const terminal = state.terminals?.[session.id]
  const issues: { tone: 'error' | 'warn'; text: string }[] = []
  const degraded = session.degraded ?? project?.degraded
  if (degraded) issues.push({ tone: 'error', text: degraded })
  if (terminal?.failure) issues.push({ tone: 'error', text: `Terminal temsili: ${terminal.failure.message}` })
  if (terminal?.checkpoint.lastError) issues.push({ tone: 'error', text: `Terminal geçmişi kaydedilemedi: ${terminal.checkpoint.lastError}` })
  if (session.isolation === 'worktree' && session.lifecycle === 'live' && sessionWorkCli(session) !== null && !trustNoteDismissed(session.id)) {
    issues.push({ tone: 'warn', text: TRUST_NOTE })
  }
  return issues
}
