import fs from 'node:fs'
import * as pty from 'node-pty'
import { EventEmitter } from 'node:events'
import { DEFAULT_STOP_TIMING, realProcessGroup, verifiedStop, type ProcessGroup, type StopOutcome, type StopTiming } from './stop'
import { runEnv } from './env'
import type { Activity } from '../shared/types'

/**
 * Run yönetimi. Bir Session'ın en çok bir canlı Run'ı olur; Run kimliği geç
 * gelen bir callback'in yeni koşuyu değiştirmesini engeller.
 *
 * NOT: terminal temsili hâlâ prototip ham tamponudur. Sözleşmenin (spec §4)
 * gerektirdiği headless ekran modeli, güvenli kesim ve checkpoint uygulama
 * sırası §8/3'ün işidir; burada yer almaz ve doğru ekran diye sunulmaz.
 */
const MAX_BUFFER = 256 * 1024

/** Idle, 30 sn girdi/çıktı sessizliğidir; kullanıcı beklediğini kanıtlamaz. */
const IDLE_AFTER_MS = 30_000

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 32

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
  buffer: string
  emitter: EventEmitter
  exited: Promise<void>
  markExited: () => void
  lastActivityAt: number
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
    env: runEnv(process.env, { sessionId: input.sessionId, runId: input.runId }),
  })

  let markExited!: () => void
  const exited = new Promise<void>((resolve) => {
    markExited = resolve
  })
  const entry: LiveRun = {
    runId: input.runId,
    pid: proc.pid,
    proc,
    buffer: '',
    emitter: new EventEmitter(),
    exited,
    markExited,
    lastActivityAt: Date.now(),
  }
  entry.emitter.setMaxListeners(0)
  live.set(input.sessionId, entry)

  proc.onData((data) => {
    entry.lastActivityAt = Date.now()
    entry.buffer += data
    if (entry.buffer.length > MAX_BUFFER) {
      let cut = entry.buffer.slice(-MAX_BUFFER)
      // Kesim bir vekil çiftinin ortasına denk gelmişse tek kalan yarıyı at.
      const first = cut.charCodeAt(0)
      if (first >= 0xdc00 && first <= 0xdfff) cut = cut.slice(1)
      entry.buffer = cut
    }
    entry.emitter.emit('data', data)
  })

  proc.onExit(({ exitCode, signal }) => {
    const exit: RunExit = {
      runId: entry.runId,
      exitCode,
      exitSignal: typeof signal === 'number' ? signal : null,
      at: Date.now(),
    }
    entry.emitter.emit('exit', exit)
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

export function buffer(sessionId: string): string {
  return live.get(sessionId)?.buffer ?? ''
}

export function write(sessionId: string, data: string): void {
  const entry = live.get(sessionId)
  if (!entry || data.length === 0) return
  // Kabul edilmiş kullanıcı girdisi aktiviteyi ilerletir.
  entry.lastActivityAt = Date.now()
  entry.proc.write(data)
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

export function subscribe(
  sessionId: string,
  onData: (data: string) => void,
  onExit: (exit: RunExit) => void,
): () => void {
  const entry = live.get(sessionId)
  if (!entry) return () => {}
  entry.emitter.on('data', onData)
  entry.emitter.on('exit', onExit)
  return () => {
    entry.emitter.off('data', onData)
    entry.emitter.off('exit', onExit)
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
