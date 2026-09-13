/** Tarayıcıdaki sıralı replay tüketicisi. Terminale giden hiçbir değişiklik bu kuyruğu atlamaz. */
export interface ScreenWriter {
  reset(): void
  resize(cols: number, rows: number): void
  write(text: string, callback: () => void): void
}

export interface StreamStatus {
  ready: boolean
  live: boolean
  owned: boolean
  /** Kontrolün şu an sahibi yok; almak başka bir istemciyi düşürmez. */
  vacant: boolean
  generation: number
  historyLoaded: boolean
  message: string
}

const bytes = (text: string) => new TextEncoder().encode(text).length

/**
 * Yazılmayı bekleyen mesaj tavanı. Replay tek başına 8 MiB olabilir ve xterm
 * onu socket'ten yavaş tüketir; üstüne 1 MiB canlı devam payı bırakılır.
 */
const MAX_QUEUED_BYTES = 8 * 1024 * 1024 + 1024 * 1024
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

export class TerminalStream {
  status: StreamStatus = { ready: false, live: false, owned: false, vacant: false, generation: 0, historyLoaded: false, message: 'Bağlanıyor…' }
  private queue = Promise.resolve()
  private queuedBytes = 0
  private stopped = false
  private sequence = 0
  private hasScreen = false
  private replay: { id: string; index: number; received: number; total: number } | null = null

  constructor(
    private screen: ScreenWriter,
    private identity: { daemonId: string; sessionId: string; runId: string },
    private changed: (status: StreamStatus) => void,
    private failed: () => void,
  ) {}

  private update(patch: Partial<StreamStatus>): void {
    this.status = { ...this.status, ...patch }
    this.changed(this.status)
  }

  suspend(message: string): void { this.update({ ready: false, message }) }
  dispose(): void { this.stopped = true; this.update({ ready: false, owned: false }) }

  receive(raw: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const size = bytes(raw)
    this.queuedBytes += size
    if (size > 256 * 1024 || this.queuedBytes > MAX_QUEUED_BYTES) {
      this.fail('Terminal akışı yetişmiyor; yeniden bağlanın')
      return Promise.resolve()
    }
    this.queue = this.queue.then(async () => {
      if (!this.stopped) await this.apply(JSON.parse(raw) as Record<string, unknown>)
    }).catch((err: unknown) => this.fail(err instanceof Error ? err.message : 'Terminal protokolü geçersiz'))
      .finally(() => { this.queuedBytes -= size })
    return this.queue
  }

  private fail(message: string): void {
    if (this.stopped) return
    this.stopped = true
    this.update({ ready: false, owned: false, message })
    this.failed()
  }

  private write(text: string): Promise<void> {
    return new Promise((resolve) => this.screen.write(text, resolve))
  }

  private async apply(m: Record<string, unknown>): Promise<void> {
    if (!m || typeof m !== 'object') throw new Error('Terminal mesajı geçersiz')
    switch (m.type) {
      case 'replay-start':
        if (this.replay || m.daemonId !== this.identity.daemonId || m.sessionId !== this.identity.sessionId ||
            m.runId !== this.identity.runId || m.formatVersion !== 1 || typeof m.snapshotId !== 'string' ||
            !integer(m.sequence) || !integer(m.cols, 2, 300) || !integer(m.rows, 1, 120) ||
            !integer(m.totalBytes, 0, 8 * 1024 * 1024) || !['screen', 'scrollback'].includes(String(m.scope)) ||
            !['live', 'inspect'].includes(String(m.mode))) throw new Error('Terminal görüntüsü kimliği veya biçimi uyuşmuyor')
        this.update({ ready: false, live: m.mode === 'live', historyLoaded: m.scope === 'scrollback', message: 'Görüntü yükleniyor…' })
        this.sequence = m.sequence
        this.replay = { id: m.snapshotId, index: 0, received: 0, total: m.totalBytes }
        this.screen.reset()
        this.screen.resize(m.cols, m.rows)
        return
      case 'replay-chunk': {
        const r = this.replay
        if (!r || m.snapshotId !== r.id || m.index !== r.index || typeof m.text !== 'string' || bytes(m.text) > 32768) throw new Error('Terminal görüntüsünde parça sırası bozuk')
        r.index += 1
        r.received += bytes(m.text)
        if (r.received > r.total) throw new Error('Terminal görüntüsü boyutu aşıldı')
        await this.write(m.text)
        return
      }
      case 'replay-end':
        if (!this.replay || m.snapshotId !== this.replay.id || m.chunkCount !== this.replay.index || this.replay.received !== this.replay.total) throw new Error('Terminal görüntüsü eksik')
        this.replay = null
        this.hasScreen = true
        this.update({ ready: true, message: this.status.live ? '' : 'Saklanmış görüntü · salt okunur' })
        return
      case 'output':
      case 'resize':
        if (this.replay || !this.hasScreen || m.sequence !== this.sequence + 1) throw new Error('Terminal akışında sıra boşluğu; yeniden bağlanın')
        this.sequence += 1
        if (m.type === 'output') {
          if (typeof m.text !== 'string' || bytes(m.text) > 32768) throw new Error('Terminal çıktısı sınırı aşıldı')
          await this.write(m.text)
        } else {
          if (!integer(m.cols, 2, 300) || !integer(m.rows, 1, 120)) throw new Error('Terminal boyutu geçersiz')
          this.screen.resize(m.cols, m.rows)
        }
        return
      case 'control':
        if (typeof m.owned !== 'boolean' || !integer(m.generation, 1)) throw new Error('Kontrol kaydı geçersiz')
        this.update({ owned: m.owned, generation: m.generation, vacant: m.vacant === true })
        return
      case 'run-ended':
        if (m.runId !== this.identity.runId) throw new Error('Run kimliği değişti')
        this.update({ live: false, owned: false, message: 'Run sonlandı · salt okunur görüntü' })
        return
      case 'history-missing':
      case 'history-unreadable':
      case 'terminal-error':
      case 'error':
        throw new Error(typeof m.message === 'string' ? m.message : 'Terminal erişilemiyor')
      default:
        throw new Error('Terminal protokolü desteklenmiyor')
    }
  }
}

/** Yapıştırma parçaları kod noktasını bölmez; kopuşta girdi yeniden gönderilmez. */
export function inputChunks(text: string, limit = 64 * 1024): string[] {
  const result: string[] = []
  let part = ''
  let size = 0
  for (const point of text) {
    const length = bytes(point)
    if (size + length > limit && part) { result.push(part); part = ''; size = 0 }
    part += point
    size += length
  }
  if (part) result.push(part)
  return result
}
