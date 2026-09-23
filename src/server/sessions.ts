import { processAgent } from './processAgent'
import fs from 'node:fs'
import * as pty from 'node-pty'
import { DEFAULT_STOP_TIMING, realProcessGroup, verifiedStop, type ProcessGroup, type StopOutcome, type StopTiming } from './stop'
import { runEnv } from './env'
import type { Activity } from '../shared/types'

/**
 * Run yönetimi. Bir Session'ın en çok bir canlı Run'ı olur; Run kimliği geç
 * gelen bir callback'in yeni koşuyu değiştirmesini engeller.
 *
 * PTY çıktısı burada saklanmaz: ekranın tek kaynağı terminal state'tir
 * (spec §4, ADR 0004). Bu modül çıktıyı yalnız sahibine iletir.
 */

/** Idle, 30 sn girdi/çıktı sessizliğidir; kullanıcı beklediğini kanıtlamaz. */
const IDLE_AFTER_MS = 30_000

export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 32

export interface RunExit {
  runId: string
  exitCode: number
  exitSignal: number | null
  at: number
}

interface LiveRun {
  runId: string
  pid: number
  proc: pty.IPty
  exited: Promise<void>
  markExited: () => void
  lastActivityAt: number
  agentRead?: { at: number; value: string | null }
}

const live = new Map<string, LiveRun>()

/**
 * Lideri çıkmış ama grubunda hâlâ süreç bulunan Run'lar. Sözleşme: liderin
 * çıkması grubun bittiğini kanıtlamaz; bu kayıt olmadan kalan çocuklar hiç
 * durdurulamaz ve worktree kilitli kalır.
 */
const lingering = new Map<string, { runId: string; pid: number }>()

/** Kullanıcının geçerli login kabuğu; bulunamazsa /bin/bash. */
function loginShell(): string {
  const shell = process.env.SHELL
  if (shell) {
    try {
      if (fs.statSync(shell).isFile()) return shell
    } catch {
      // geçersiz SHELL: varsayılana düşülür
    }
  }
  return '/bin/bash'
}

/** Komut aynen program olarak yürür; exec/kimlik/resume bayrağı eklenmez. */
function programFor(command: string | null): { file: string; args: string[] } {
  if (command === null) return { file: loginShell(), args: ['-l'] }
  return { file: '/bin/bash', args: ['-lc', command] }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    // EPERM: grup var ama sinyal gönderemiyoruz — yaşıyor sayılır.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Lider gerçekten toplanmış mı; pid geri dönüştürülmüşse gruba sinyal atılmaz. */
function leaderReaped(pid: number): boolean {
  return !fs.existsSync(`/proc/${pid}`)
}

export interface SpawnInput {
  sessionId: string
  runId: string
  command: string | null
  cwd: string
  cols?: number
  rows?: number
  /** Kullanıcının environment.json değerleri; çağıran Run öncesi okuyup doğrular. */
  userEnv?: Record<string, string>
  /** Claude konuşma kancasının olay dizini. */
  hookDir?: string
  /** Ham PTY çıktısı; sıralı ekran modeline verilir. */
  onData: (chunk: string) => void
  onExit: (exit: RunExit) => void
}

export function spawn(input: SpawnInput): { runId: string; pid: number } {
  if (live.has(input.sessionId)) {
    throw new Error(`Oturumun canlı Run'ı var; yeni Run açılmaz: ${input.sessionId}`)
  }
  // cwd eksikse yeni Run yok: dizin yaratma veya shared fallback yapılmaz.
  try {
    if (!fs.statSync(input.cwd).isDirectory()) throw new Error('dizin değil')
  } catch {
    throw new Error(`Çalışma dizini (cwd) erişilemez: ${input.cwd}`)
  }

  const { file, args } = programFor(input.command)
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: input.cols ?? DEFAULT_COLS,
    rows: input.rows ?? DEFAULT_ROWS,
    cwd: input.cwd,
    env: runEnv(process.env, { sessionId: input.sessionId, runId: input.runId, hookDir: input.hookDir }, input.userEnv),
  })

  let markExited!: () => void
  const exited = new Promise<void>((resolve) => {
    markExited = resolve
  })
  const entry: LiveRun = {
    runId: input.runId,
    pid: proc.pid,
    proc,
    exited,
    markExited,
    lastActivityAt: Date.now(),
  }
  live.set(input.sessionId, entry)

  proc.onData((data) => {
    entry.lastActivityAt = Date.now()
    input.onData(data)
  })

  proc.onExit(({ exitCode, signal }) => {
    const exit: RunExit = {
      runId: entry.runId,
      exitCode,
      exitSignal: typeof signal === 'number' ? signal : null,
      at: Date.now(),
    }
    entry.markExited()

    // Yalnız hâlâ kayıtlı olan Run kendi kaydını kapatır: geç gelen bir çıkış
    // yeni Run'ın lifecycle'ını değiştirmez.
    if (live.get(input.sessionId) !== entry) return
    live.delete(input.sessionId)

    // Lider çıktı; çocukları aynı grupta kalmış olabilir.
    if (groupAlive(entry.pid)) {
      lingering.set(input.sessionId, { runId: entry.runId, pid: entry.pid })
    }
    input.onExit(exit)
  })

  return { runId: input.runId, pid: proc.pid }
}

export function isLive(sessionId: string, runId?: string): boolean {
  const entry = live.get(sessionId)
  if (!entry) return false
  return runId === undefined || entry.runId === runId
}

export function currentRunId(sessionId: string): string | null {
  return live.get(sessionId)?.runId ?? null
}

export function liveCount(): number {
  return live.size
}

export function activity(sessionId: string): { activity: Activity; lastActivityAt: number } | null {
  const entry = live.get(sessionId)
  if (!entry) return null
  return {
    activity: Date.now() - entry.lastActivityAt < IDLE_AFTER_MS ? 'active' : 'idle',
    lastActivityAt: entry.lastActivityAt,
  }
}

/** Lideri çıkmış ama grubu yaşayan bir Run var mı; ölmüşse kayıt temizlenir. */
export function hasLingeringGroup(sessionId: string): boolean {
  const record = lingering.get(sessionId)
  if (!record) return false
  if (!groupAlive(record.pid)) {
    lingering.delete(sessionId)
    return false
  }
  return true
}

export function write(sessionId: string, data: string): void {
  const entry = live.get(sessionId)
  if (!entry || data.length === 0) return
  // Kabul edilmiş kullanıcı girdisi aktiviteyi ilerletir.
  entry.lastActivityAt = Date.now()
  entry.proc.write(data)
}

/**
 * Ekran modelinin sorgulara ürettiği cevap. Kullanıcı girdisi değildir:
 * lastActivity'yi ilerletmez.
 */
export function respond(sessionId: string, data: string): void {
  const entry = live.get(sessionId)
  if (!entry || data.length === 0) return
  entry.proc.write(data)
}

/** Emülatör yetişemediğinde üretici duraklatılır; hiçbir çıktı düşürülmez. */
export function pause(sessionId: string): void {
  live.get(sessionId)?.proc.pause()
}

export function resume(sessionId: string): void {
  live.get(sessionId)?.proc.resume()
}

export function resize(sessionId: string, cols: number, rows: number): void {
  const entry = live.get(sessionId)
  if (!entry) return
  try {
    entry.proc.resize(cols, rows)
  } catch {
    // pencere yeniden boyutlanırken süreç ölmüş olabilir
  }
}

/**
 * Süreç grubunu doğrulanmış biçimde durdurur. Timeout başarı değildir: sonuç
 * verified=false ise çağıran yeni Run başlatmaz ve silme yapmaz.
 */
export async function stop(sessionId: string, timing: StopTiming = DEFAULT_STOP_TIMING): Promise<StopOutcome> {
  const entry = live.get(sessionId)
  if (entry) {
    const outcome = await verifiedStop(realProcessGroup(entry.pid, entry.exited), timing)
    if (outcome.verified) lingering.delete(sessionId)
    return outcome
  }

  const record = lingering.get(sessionId)
  if (record) {
    if (!groupAlive(record.pid)) {
      lingering.delete(sessionId)
      return { verified: true, alreadyGone: true, escalated: false }
    }
    if (!leaderReaped(record.pid)) {
      // Lider pid'i yeniden kullanılmış olabilir; yabancı gruba sinyal atmayız.
      return { verified: false, reason: 'group_running' }
    }
    const group: ProcessGroup = realProcessGroup(record.pid, Promise.resolve())
    const outcome = await verifiedStop(group, timing)
    if (outcome.verified) lingering.delete(sessionId)
    return outcome
  }

  return { verified: true, alreadyGone: true, escalated: false }
}

/** Kapanışta tüm süreç gruplarını durdurmayı dener; sonuçları bildirir. */
export async function stopAll(timing: StopTiming = DEFAULT_STOP_TIMING): Promise<Map<string, StopOutcome>> {
  const ids = new Set([...live.keys(), ...lingering.keys()])
  const results = new Map<string, StopOutcome>()
  for (const id of ids) results.set(id, await stop(id, timing))
  return results
}

export function foregroundAgent(sessionId: string): string | null {
  const entry = live.get(sessionId)
  if (!entry) return null
  if (!entry.agentRead || Date.now() - entry.agentRead.at >= 3000) entry.agentRead = { at: Date.now(), value: processAgent(entry.pid) }
  return entry.agentRead.value
}
