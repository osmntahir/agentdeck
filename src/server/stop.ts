/**
 * Doğrulanmış durdurma. Sözleşme iki şeyi ayrıca söylüyor: timeout başarı
 * değildir ve PTY liderinin çıkması süreç grubunun bittiğini tek başına
 * kanıtlamaz. Bu yüzden lider çıkışı beklenir *ve* grup ayrıca sorgulanır.
 */
export interface ProcessGroup {
  /** Sinyali grubun tamamına gönderir (kill(-pid, sig)). */
  signal(sig: 'SIGHUP' | 'SIGKILL'): void
  /** Grupta hâlâ süreç var mı (kill(-pid, 0) ESRCH vermiyor mu). */
  alive(): boolean
  /** Lider süreç gerçekten çıktığında çözülür. */
  readonly exited: Promise<void>
}

export type StopOutcome =
  | { verified: true; alreadyGone: boolean; escalated: boolean }
  | { verified: false; reason: 'leader_running' | 'group_running' }

export interface StopTiming {
  /** SIGHUP sonrası liderin kendiliğinden çıkması için verilen süre. */
  hangupWaitMs: number
  /** SIGKILL sonrası lider çıkışı ve grup boşalması için verilen süre. */
  killWaitMs: number
  pollMs: number
}

export const DEFAULT_STOP_TIMING: StopTiming = {
  hangupWaitMs: 2000,
  killWaitMs: 1500,
  pollMs: 50,
}

/** Zamanlayıcıyı arkada bırakmayan, iptal edilebilir bekleme. */
function raceWithDeadline(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitGroupGone(group: ProcessGroup, budgetMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (group.alive()) {
    if (Date.now() >= deadline) return false
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
  return true
}

export async function verifiedStop(
  group: ProcessGroup,
  timing: StopTiming = DEFAULT_STOP_TIMING,
): Promise<StopOutcome> {
  if (!group.alive()) return { verified: true, alreadyGone: true, escalated: false }

  group.signal('SIGHUP')
  let leaderExited = await raceWithDeadline(group.exited, timing.hangupWaitMs)
  let escalated = false

  if (!leaderExited || group.alive()) {
    escalated = true
    group.signal('SIGKILL')
    if (!leaderExited) {
      leaderExited = await raceWithDeadline(group.exited, timing.killWaitMs)
      if (!leaderExited) return { verified: false, reason: 'leader_running' }
    }
  }

  // Lider çıktı; çocukları aynı grupta yaşıyor olabilir.
  if (!(await waitGroupGone(group, timing.killWaitMs, timing.pollMs))) {
    return { verified: false, reason: 'group_running' }
  }
  return { verified: true, alreadyGone: false, escalated }
}

/** Gerçek bir PTY liderinden süreç grubu görünümü kurar. */
export function realProcessGroup(pid: number, exited: Promise<void>): ProcessGroup {
  return {
    signal(sig) {
      try {
        // forkpty setsid yapar: lider grup lideridir, negatif pid tüm gruba gider.
        process.kill(-pid, sig)
      } catch {
        // grup çoktan gitmiş olabilir; alive() kararı verir
      }
    },
    alive() {
      try {
        process.kill(-pid, 0)
        return true
      } catch (err) {
        // EPERM: süreç var ama sinyal gönderemiyoruz — yaşıyor sayılır.
        return (err as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    exited,
  }
}
