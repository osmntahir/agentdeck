/**
 * Görünür istemcinin tek GET state döngüsü (spec §5, §7). Ağ, zamanlayıcı ve
 * sekme görünürlüğü dışarıdan verilir; böylece döngü tarayıcı olmadan sınanır.
 */

/** Başarılı okumadan sonra bir sonraki okuma, önceki istek bittikten bu kadar sonra. */
const POLL_INTERVAL_MS = 2000

/** Ağ ve sunucu hatasında ardışık bekleme; son değer tekrarlanır. */
const BACKOFF_MS = [2000, 4000, 8000, 10000]

export interface PollFailure {
  /** auth: 401/403, otomatik deneme durur. server: HTTP hata cevabı. network: cevap yok veya zaman aşımı. */
  kind: 'network' | 'auth' | 'server'
  message: string
  /** Sonraki otomatik denemeye kalan süre; deneme planlanmadıysa null. */
  retryInMs: number | null
}

export interface StatePollerDeps<S> {
  fetchState: () => Promise<S>
  schedule: (fn: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
  isHidden: () => boolean
  onState: (state: S) => void
  onFailure: (failure: PollFailure) => void
}

function classify(error: unknown): Omit<PollFailure, 'retryInMs'> {
  const status = (error as { status?: unknown } | null)?.status
  if (status === 401) {
    return { kind: 'auth', message: 'Erişim reddedildi: token geçersiz. Uygulamayı daemon’ın verdiği adresle yeniden açın.' }
  }
  if (status === 403) return { kind: 'auth', message: 'Erişim reddedildi: bu adresin origin’i kabul edilmedi.' }
  if (typeof status === 'number') {
    // Durum okunamadı; süreçlerin öldüğü sonucu çıkarılmaz.
    return { kind: 'server', message: `Durum okunamadı (HTTP ${status}); oturumlar çalışmaya devam ediyor olabilir.` }
  }
  return { kind: 'network', message: 'Daemon’a ulaşılamıyor; son görünüm eski olabilir ve terminal girdisi kapalı.' }
}

export function createStatePoller<S extends { daemonId: string; revision: number }>(deps: StatePollerDeps<S>) {
  /** Her okuma kendi generation'ını taşır; yalnız en yeni isteğin sonucu işlenir. */
  let generation = 0
  let timer: unknown = null
  let failures = 0
  let stopped = false
  let applied: { daemonId: string; revision: number } | null = null

  const cancelPlanned = () => {
    if (timer !== null) deps.cancel(timer)
    timer = null
  }

  /** Gizli sekmede sonraki okuma planlanmaz; dönüşte visibilityChanged hemen okur. */
  const plan = (ms: number): boolean => {
    cancelPlanned()
    if (stopped || deps.isHidden()) return false
    timer = deps.schedule(() => {
      timer = null
      void poll()
    }, ms)
    return true
  }

  /** Hiç reddetmez: hata onFailure ile bildirilir. */
  const poll = async (): Promise<void> => {
    if (stopped) return
    const current = ++generation
    cancelPlanned()
    let next: S
    try {
      next = await deps.fetchState()
    } catch (error) {
      if (current !== generation || stopped) return
      const failure = classify(error)
      if (failure.kind === 'auth') {
        // Yetki hatası kendiliğinden düzelmez; yalnız açık deneme veya sekmeye dönüş okur.
        deps.onFailure({ ...failure, retryInMs: null })
        return
      }
      const delay = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]
      deps.onFailure({ ...failure, retryInMs: plan(delay) ? delay : null })
      return
    }
    if (current !== generation || stopped) return
    failures = 0
    // Aynı daemon'ın eski revision'ı atılır. Activity/preview değişimi aynı
    // revision'da gelebildiği için eşit revision işlenir.
    if (applied === null || applied.daemonId !== next.daemonId || next.revision >= applied.revision) {
      applied = { daemonId: next.daemonId, revision: next.revision }
      deps.onState(next)
    }
    plan(POLL_INTERVAL_MS)
  }

  return {
    start: () => void poll(),
    /** Mutation sonrası ve kullanıcı isteğiyle beklemeden okur. */
    refresh: () => poll(),
    visibilityChanged: () => {
      if (deps.isHidden()) cancelPlanned()
      else void poll()
    },
    stop: () => {
      stopped = true
      cancelPlanned()
    },
  }
}
