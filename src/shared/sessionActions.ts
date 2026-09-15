import {
  CLI_COMMANDS,
  explicitResumeOf,
  launchCli,
  pickerCli,
  repeatLaunchCommand,
  type LaunchCli,
} from './launchPolicy'
import { commandLabel, hasRunningProcesses, type Session, type SessionView } from './types'

/**
 * Odak çubuğundaki çalışma eylemleri (spec §3). Yönetilen fresh/resume
 * kimliği üretmez; seçici ve yeni konuşma literal komuttur.
 */

export type SessionWorkAction =
  | { kind: 'stop'; primary: false; label: string; description: string }
  | { kind: 'continue'; primary: boolean; label: string; description: string; command: string }
  | { kind: 'fresh'; primary: boolean; label: string; description: string; command: string }
  | { kind: 'restart'; primary: boolean; label: string; description: string }
  | { kind: 'launch'; primary: false; label: string; description: string }

/** Konuşma eylemlerinin CLI'sı son başarılı Run'dır; başlangıç Command'ı değil. */
export function sessionWorkCli(session: Pick<Session, 'command' | 'lastLaunch'>): LaunchCli | null {
  const last = session.lastLaunch
  if (last?.mode === 'fresh' || last?.mode === 'picker' || last?.mode === 'resume') {
    return launchCli(last.cli)
  }
  const command = repeatLaunchCommand(session) ?? null
  const explicit = explicitResumeOf(command)
  return launchCli(command) ?? pickerCli(command) ?? (explicit ? launchCli(explicit.cli) : null)
}

function hasConversationCandidate(session: Pick<Session, 'command' | 'lastLaunch'>): boolean {
  const last = session.lastLaunch
  if (last?.mode === 'resume') return true
  if (last?.mode === 'fresh' && last.conversationId) return true
  return explicitResumeOf(repeatLaunchCommand(session) ?? null) !== null
}

function withStop(running: boolean, label: string, description: string): { label: string; description: string } {
  if (!running) return { label, description }
  return {
    label: `durdur ve ${label}`,
    description: `Çalışan süreç grubunu doğrulanmış biçimde durdurur, sonra ${description}`,
  }
}

function restartDescription(session: Pick<Session, 'command' | 'lastLaunch'>): string {
  const last = session.lastLaunch
  if (last?.mode === 'resume') return `aynı konuşmayı sürdürür (${last.cli} ${last.conversationId})`
  if (last?.mode === 'picker') return `CLI'ın kendi konuşma seçicisini tekrar açar`
  if (last?.mode === 'fresh') return 'aynı çalışma kopyasında yeni konuşma açar; önceki konuşma silinmez.'
  return `komutu aynen yeniden çalıştırır: ${commandLabel(repeatLaunchCommand(session) ?? null)}`
}

export function sessionWorkActions(session: SessionView): SessionWorkAction[] {
  const running = hasRunningProcesses(session)
  const actions: SessionWorkAction[] = []
  if (running) {
    actions.push({
      kind: 'stop',
      primary: false,
      label: 'durdur',
      description: 'Süreç grubunu doğrulanmış biçimde durdurur; kayıt, dosyalar, branch ve terminal geçmişi kalır.',
    })
  }

  const cli = sessionWorkCli(session)
  const restartCommand = repeatLaunchCommand(session)
  const picker = cli ? CLI_COMMANDS[cli].picker : null
  const lastMode = session.lastLaunch?.mode ?? null
  const showContinue = picker !== null && restartCommand !== picker
  const showFresh = cli !== null && (lastMode === 'fresh' || restartCommand !== cli)
  const showRestart = lastMode !== 'fresh' && restartCommand !== undefined
  const candidate = hasConversationCandidate(session)
  const continuePrimary = showContinue && candidate
  const restartPrimary = showRestart && !continuePrimary
  const freshPrimary = showFresh && !continuePrimary && !restartPrimary
  const work: SessionWorkAction[] = []

  if (showContinue && picker) {
    const copy = withStop(
      running,
      'konuşmayı sürdür',
      "aynı konuşmayı sürdürür: CLI'ın kendi seçicisini açar; hangisinin süreceğini siz seçersiniz.",
    )
    work.push({
      kind: 'continue',
      primary: continuePrimary,
      command: picker,
      label: copy.label,
      description: copy.description,
    })
  }
  if (showFresh && cli) {
    const copy = withStop(
      running,
      'aynı dosyalarla yeni konuşma',
      'aynı çalışma kopyasında yeni konuşma açar; önceki konuşma silinmez.',
    )
    work.push({
      kind: 'fresh',
      primary: freshPrimary,
      command: cli,
      label: copy.label,
      description: copy.description,
    })
  }
  if (showRestart) {
    const copy = withStop(
      running,
      'yeniden çalıştır',
      restartDescription(session),
    )
    work.push({
      kind: 'restart',
      primary: restartPrimary,
      label: copy.label,
      description: copy.description,
    })
  }

  const launchCopy = withStop(
    running,
    'komut çalıştır…',
    'bu çalışma kopyasında başka bir komut veya CLI seçicisi çalıştırır; başlangıç programı değişmez.',
  )
  work.push({
    kind: 'launch',
    primary: false,
    label: launchCopy.label,
    description: launchCopy.description,
  })
  const primary = work.find((action) => action.primary)
  const ordered = primary ? [primary, ...work.filter((action) => action !== primary)] : work
  return [...actions, ...ordered]
}
