import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { CheckpointRead, CheckpointStore } from './checkpoints'
import type { StoredRun } from '../shared/types'
import { chunkText, clampCols, clampRows, type Preview, type Snapshot, type SnapshotScope, type TerminalFailure } from './terminalState'
import type { WorkerEvent, WorkerRequest } from './terminalWorker'

/**
 * Terminal-state worker'ının ana iş parçacığı cephesi. Sıra numaralandırma,
 * abonelik bariyeri, in-flight bütçesi (PTY pause/resume) ve checkpoint
 * zamanlaması buradadır; ekran modelinin kendisi worker'da yaşar.
 *
 * Sözleşme gereği hiçbir çıktı sessizce düşürülmez: emülatör yetişemezse
 * üretici duraklatılır. Worker çökerse PTY sırf görüntü hatası diye
 * öldürülmez; input kapatılır, temsil hatası kaydedilir, sahte snapshot yok.
 */

/** Run başına in-flight UTF-8 kuyruğu; aşılınca ilgili PTY duraklatılır. */
const RUN_HIGH_WATER = 1024 * 1024
const RUN_LOW_WATER = 256 * 1024
const TOTAL_HIGH_WATER = 8 * 1024 * 1024
const TOTAL_LOW_WATER = 4 * 1024 * 1024
const MAX_PENDING_WRITES = 1024

/** Replay sürerken biriken canlı devam kuyruğu; aşılırsa izleyici ayrılır. */
const ATTACH_BUFFER_BYTES = 1024 * 1024

/** Dirty olduktan sonra flush bu süre içinde başlatılır. */
const CHECKPOINT_DELAY_MS = 1000

export type TerminalEvent =
  | { type: 'output'; sequence: number; text: string }
  | { type: 'resize'; sequence: number; cols: number; rows: number }
  | { type: 'failure'; failure: TerminalFailure }
  | { type: 'overflow' }
  | { type: 'ended' }

export interface Replay {
  snapshot: Snapshot
  sequence: number
}

export interface Attachment {
  /** Sıralı akışa bariyer koyar; dönen sequence'tan sonrası aboneye iner. */
  snapshot(scope: SnapshotScope): Promise<Replay>
  /** Replay bittikten sonra biriken olayları sırayla akıtmaya başlar. */
  resume(): void
  close(): void
}

export type PreviewResult =
  | { state: 'ready'; preview: Preview; reason?: undefined }
  | { state: 'preparing'; preview?: undefined; reason?: undefined }
  | { state: 'unavailable'; preview?: undefined; reason: string }

export interface OpenInput {
  sessionId: string
  runId: string
  cols: number
  rows: number
  /** Emülatörün sorgu cevabı; PTY'ye yazılır ve aktivite saymaz. */
  onReply?: (data: string) => void
  onPause?: () => void
  onResume?: () => void
}

export interface CheckpointStatus {
  lastSuccessAt: number | null
  lastError: string | null
}

export interface TerminalHost {
  open(input: OpenInput): void
  feed(runId: string, chunk: string): void
  resize(runId: string, cols: number, rows: number): Promise<{ cols: number; rows: number; sequence: number } | null>
  attach(runId: string, listener: (event: TerminalEvent) => void): Attachment | null
  preview(runId: string): Promise<PreviewResult>
  /** Kuyruktaki bütün yazımlar emülatörde işlenene kadar bekler. */
  drain(runId: string): Promise<void>
  close(runId: string): Promise<void>
  history(sessionId: string, runId: string): Promise<CheckpointRead>
  /** Canlı olmayan bir Run'ın son görüntüsünden kart önizlemesi. */
  historyPreview(sessionId: string, runId: string): Promise<PreviewResult>
  /** Run kayda girdi: saklama sınırı (son iki Run) ancak şimdi uygulanır. */
  publish(sessionId: string, runId: string): Promise<void>
  /** Run kayda hiç girmedi: görüntüsü atılır, önceki Run'ların kayıtlarına dokunulmaz. */
  discard(sessionId: string, runId: string): Promise<void>
  removeSession(sessionId: string): void
  /** Saklanmış Run görüntüleri, en yeni önce. */
  listRuns(sessionId: string): StoredRun[]
  failure(runId: string): TerminalFailure | null
  checkpointStatus(runId: string): CheckpointStatus
  shutdown(): Promise<void>
}

export interface TerminalHostOptions {
  checkpoints: CheckpointStore
  checkpointDelayMs?: number
  /** Test seam'i: gerçek worker'ı sarmalamak için. Üretimde kullanılmaz. */
  spawnWorker?: (createDefault: () => Worker) => Worker
}

interface Subscriber {
  listener: (event: TerminalEvent) => void
  buffered: TerminalEvent[] | null
  bufferedBytes: number
  barrier: number | null
  overflowed: boolean
}

interface HostRun {
  sessionId: string
  runId: string
  sequence: number
  processed: number
  inflightBytes: number
  pendingWrites: number
  paused: boolean
  closed: boolean
  failure: TerminalFailure | null
  subscribers: Set<Subscriber>
  drains: (() => void)[]
  pendingResizes: Map<number, (applied: { cols: number; rows: number; sequence: number } | null) => void>
  onReply?: (data: string) => void
  onPause?: () => void
  onResume?: () => void
  dirty: boolean
  flushTimer: NodeJS.Timeout | null
  flushing: Promise<void> | null
  /** Kayda girmemiş Run'ın yazımı eski kayıtları budayamaz. */
  published: boolean
}

/** Dev'de kaynak .ts, üretimde derlenmiş .js yüklenir. */
function defaultSpawn(): Worker {
  const isSource = __filename.endsWith('.ts')
  const file = path.join(__dirname, isSource ? 'terminalWorker.ts' : 'terminalWorker.js')
  if (!isSource) return new Worker(file)
  // tsx ile çalışırken worker CJS olarak yüklenmeli; aksi hâlde Node dosyayı
  // ESM sanar ve bağımlılık çözümlemesi ayrışır.
  return new Worker(`require('tsx/cjs');require(${JSON.stringify(file)})`, { eval: true, execArgv: [] })
}

export function createTerminalHost(options: TerminalHostOptions): TerminalHost {
  const checkpointDelayMs = options.checkpointDelayMs ?? CHECKPOINT_DELAY_MS
  const runs = new Map<string, HostRun>()
  const checkpointStatus = new Map<string, CheckpointStatus>()
  const pending = new Map<number, { runId: string; resolve: (value: never) => void; reject: (err: Error) => void }>()
  let inspections = 0
  let totalInflight = 0
  let nextRequestId = 1
  let worker: Worker | null = null
  const closing = new Map<string, Promise<void>>()

  /**
   * Yazım yolunun durum kaydı; yoksa açar. Okuma yolu (checkpointStatus) kayıt
   * açmaz. Sınır dolunca yalnız kapanmış Run'ların durumu atılır.
   */
  function status(runId: string): CheckpointStatus {
    let entry = checkpointStatus.get(runId)
    if (!entry) {
      entry = { lastSuccessAt: null, lastError: null }
      checkpointStatus.set(runId, entry)
      if (checkpointStatus.size > 512) {
        for (const key of checkpointStatus.keys()) {
          if (!runs.has(key)) {
            checkpointStatus.delete(key)
            break
          }
        }
      }
    }
    return entry
  }

  function ensureWorker(): Worker {
    if (worker) return worker
    const created = options.spawnWorker ? options.spawnWorker(defaultSpawn) : defaultSpawn()
    created.on('message', onWorkerEvent)
    created.on('error', (err) => loseWorker(created, `worker hatası: ${err.message}`))
    created.on('exit', (code) => loseWorker(created, `worker beklenmedik biçimde kapandı (kod ${code})`))
    worker = created
    return created
  }

  function send(request: WorkerRequest): void {
    ensureWorker().postMessage(request)
  }

  function request<T>(build: (requestId: number) => WorkerRequest, runId: string): Promise<T> {
    if (pending.size >= 1024) return Promise.reject(new Error('Terminal istek kuyruğu dolu'))
    const requestId = nextRequestId++
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, { runId, resolve: resolve as (value: never) => void, reject })
      try {
        send(build(requestId))
      } catch (err) {
        pending.delete(requestId)
        reject(err as Error)
      }
    })
  }

  /** Worker gittiğinde: PTY'ler yaşamaya devam eder, temsil hatası kaydedilir. */
  function loseWorker(source: Worker, message: string): void {
    if (worker !== source) return
    worker = null
    const failure: TerminalFailure = {
      code: 'engine_error',
      message: `Terminal temsili kayboldu: ${message}; sahte ekran kurulmaz`,
    }
    for (const run of runs.values()) markFailed(run, failure)
    for (const [requestId, entry] of pending) {
      pending.delete(requestId)
      entry.reject(new Error(failure.message))
    }
  }

  function markFailed(run: HostRun, failure: TerminalFailure): void {
    if (run.failure) return
    run.failure = failure
    totalInflight -= run.inflightBytes
    run.inflightBytes = 0
    run.pendingWrites = 0
    for (const resolve of run.pendingResizes.values()) resolve(null)
    run.pendingResizes.clear()
    if (run.paused) {
      run.paused = false
      run.onResume?.()
    }
    for (const other of runs.values()) maybeResume(other)
    deliver(run, { type: 'failure', failure })
    releaseDrains(run)
    if (run.flushTimer) {
      clearTimeout(run.flushTimer)
      run.flushTimer = null
    }
  }

  function releaseDrains(run: HostRun): void {
    const waiting = run.drains.splice(0, run.drains.length)
    for (const resolve of waiting) resolve()
  }

  function deliver(run: HostRun, event: TerminalEvent, sequence?: number): void {
    for (const subscriber of run.subscribers) {
      if (subscriber.buffered !== null) {
        if (subscriber.overflowed) continue
        subscriber.bufferedBytes += 64 + (event.type === 'output' ? Buffer.byteLength(event.text) : 0)
        if (subscriber.bufferedBytes > ATTACH_BUFFER_BYTES) {
          subscriber.overflowed = true
          subscriber.buffered = null
          subscriber.listener({ type: 'overflow' })
          continue
        }
        subscriber.buffered.push(event)
        continue
      }
      if (subscriber.barrier !== null && sequence !== undefined && sequence <= subscriber.barrier) continue
      subscriber.listener(event)
    }
  }

  function maybePause(run: HostRun): void {
    if (run.paused) return
    const over =
      run.inflightBytes >= RUN_HIGH_WATER || run.pendingWrites >= MAX_PENDING_WRITES || totalInflight >= TOTAL_HIGH_WATER
    if (!over) return
    run.paused = true
    run.onPause?.()
  }

  function maybeResume(run: HostRun): void {
    if (!run.paused) return
    if (run.inflightBytes > RUN_LOW_WATER || totalInflight > TOTAL_LOW_WATER) return
    run.paused = false
    run.onResume?.()
  }

  function markDirty(run: HostRun): void {
    if (run.closed || run.failure) return
    run.dirty = true
    if (run.flushTimer || run.flushing) return
    run.flushTimer = setTimeout(() => {
      run.flushTimer = null
      run.flushing = flush(run).finally(() => {
        run.flushing = null
        if (run.dirty) markDirty(run)
      })
    }, checkpointDelayMs)
    run.flushTimer.unref?.()
  }

  async function flush(run: HostRun): Promise<void> {
    if (run.failure || !runs.has(run.runId)) return
    run.dirty = false
    try {
      const replay = await request<{ snapshot: Snapshot; sequence: number }>(
        (requestId) => ({ type: 'snapshot', runId: run.runId, requestId, scope: 'scrollback' }),
        run.runId,
      )
      await writeCheckpoint(run, replay.snapshot, replay.sequence)
    } catch (err) {
      status(run.runId).lastError = (err as Error).message
    }
  }

  async function writeCheckpoint(run: HostRun, snapshot: Snapshot, sequence: number): Promise<void> {
    try {
      await options.checkpoints.write({
        sessionId: run.sessionId,
        runId: run.runId,
        text: snapshot.text,
        scope: snapshot.scope,
        cols: snapshot.cols,
        rows: snapshot.rows,
        sequence,
        capturedAt: Date.now(),
      })
      const entry = status(run.runId)
      entry.lastSuccessAt = Date.now()
      entry.lastError = null
      if (run.published) options.checkpoints.prune(run.sessionId, run.runId)
    } catch (err) {
      status(run.runId).lastError = (err as Error).message
    }
  }

  function onWorkerEvent(event: WorkerEvent): void {
    const run = 'runId' in event ? runs.get(event.runId) : undefined
    switch (event.type) {
      case 'output': {
        if (!run || run.failure) return
        run.inflightBytes -= event.cost
        totalInflight -= event.cost
        run.pendingWrites -= 1
        run.processed += 1
        deliver(run, { type: 'output', sequence: event.sequence, text: event.text }, event.sequence)
        markDirty(run)
        for (const other of runs.values()) maybeResume(other)
        if (run.pendingWrites <= 0) releaseDrains(run)
        return
      }
      case 'reply':
        run?.onReply?.(event.data)
        return
      case 'resized': {
        if (!run) return
        deliver(run, { type: 'resize', sequence: event.sequence, cols: event.cols, rows: event.rows }, event.sequence)
        markDirty(run)
        run.pendingResizes.get(event.sequence)?.({ cols: event.cols, rows: event.rows, sequence: event.sequence })
        run.pendingResizes.delete(event.sequence)
        return
      }
      case 'failure':
        if (run) markFailed(run, event.failure)
        return
      case 'snapshot': {
        const entry = pending.get(event.requestId)
        pending.delete(event.requestId)
        entry?.resolve({ snapshot: event.snapshot, sequence: event.sequence } as never)
        return
      }
      case 'preview':
      case 'inspected': {
        const entry = pending.get(event.requestId)
        pending.delete(event.requestId)
        entry?.resolve(event.preview as never)
        return
      }
      case 'closed': {
        const entry = pending.get(event.requestId)
        pending.delete(event.requestId)
        entry?.resolve({ snapshot: event.snapshot, sequence: event.sequence } as never)
        return
      }
      case 'rejected': {
        const entry = pending.get(event.requestId)
        pending.delete(event.requestId)
        entry?.reject(new Error(event.message))
        return
      }
    }
  }

  return {
    open(input: OpenInput): void {
      if (runs.has(input.runId)) return
      runs.set(input.runId, {
        sessionId: input.sessionId,
        runId: input.runId,
        sequence: 0,
        processed: 0,
        inflightBytes: 0,
        pendingWrites: 0,
        paused: false,
        closed: false,
        failure: null,
        subscribers: new Set(),
        drains: [],
        pendingResizes: new Map(),
        onReply: input.onReply,
        onPause: input.onPause,
        onResume: input.onResume,
        dirty: false,
        flushTimer: null,
        flushing: null,
        published: false,
      })
      status(input.runId)
      send({ type: 'open', runId: input.runId, cols: clampCols(input.cols), rows: clampRows(input.rows) })
    },

    feed(runId: string, chunk: string): void {
      const run = runs.get(runId)
      if (!run || run.failure || run.closed || chunk === '') return
      for (const part of chunkText(chunk, 28 * 1024)) {
        run.sequence += 1
        const cost = Buffer.byteLength(part)
        run.inflightBytes += cost
        totalInflight += cost
        run.pendingWrites += 1
        send({ type: 'write', runId, sequence: run.sequence, chunk: part })
        maybePause(run)
      }
    },

    async resize(runId: string, cols: number, rows: number) {
      const run = runs.get(runId)
      if (!run || run.failure || run.closed) return null
      run.sequence += 1
      const sequence = run.sequence
      const applied = new Promise<{ cols: number; rows: number; sequence: number } | null>((resolve) => {
        run.pendingResizes.set(sequence, resolve)
      })
      send({ type: 'resize', runId, sequence, cols: clampCols(cols), rows: clampRows(rows) })
      return applied
    },

    attach(runId: string, listener: (event: TerminalEvent) => void): Attachment | null {
      const run = runs.get(runId)
      if (!run) return null
      const subscriber: Subscriber = {
        listener,
        buffered: [],
        bufferedBytes: 0,
        barrier: null,
        overflowed: false,
      }
      run.subscribers.add(subscriber)

      return {
        async snapshot(scope: SnapshotScope): Promise<Replay> {
          if (run.failure) throw new Error(run.failure.message)
          if (subscriber.overflowed) throw new Error('İzleyici yetişemiyor')
          subscriber.buffered = []
          subscriber.bufferedBytes = 0
          const replay = await request<Replay>(
            (requestId) => ({ type: 'snapshot', runId, requestId, scope }),
            runId,
          )
          subscriber.barrier = replay.sequence
          return replay
        },
        resume(): void {
          const queued = subscriber.buffered
          subscriber.buffered = null
          if (!queued) return
          for (const event of queued) {
            const sequence = event.type === 'output' || event.type === 'resize' ? event.sequence : undefined
            if (subscriber.barrier !== null && sequence !== undefined && sequence <= subscriber.barrier) continue
            subscriber.listener(event)
          }
        },
        close(): void {
          run.subscribers.delete(subscriber)
        },
      }
    },

    async preview(runId: string): Promise<PreviewResult> {
      const run = runs.get(runId)
      if (!run) return { state: 'unavailable', reason: 'Bu Run için ekran modeli yok' }
      if (run.failure) return { state: 'unavailable', reason: run.failure.message }
      if (run.processed === 0) return { state: 'preparing' }
      try {
        const preview = await request<Preview>((requestId) => ({ type: 'preview', runId, requestId }), runId)
        return { state: 'ready', preview }
      } catch (err) {
        return { state: 'unavailable', reason: (err as Error).message }
      }
    },

    drain(runId: string): Promise<void> {
      const run = runs.get(runId)
      if (!run || run.pendingWrites <= 0) return Promise.resolve()
      return new Promise<void>((resolve) => run.drains.push(resolve))
    },

    close(runId: string): Promise<void> {
      const previous = closing.get(runId)
      if (previous) return previous
      const run = runs.get(runId)
      if (!run) return Promise.resolve()
      run.closed = true
      if (run.flushTimer) clearTimeout(run.flushTimer)
      run.flushTimer = null
      const done = (async () => {
        await run.flushing
        if (worker) {
          try {
            const result = await request<{ snapshot: Snapshot | null; sequence: number }>(
              (requestId) => ({ type: 'close', runId, requestId }), runId,
            )
            if (result.snapshot && !run.failure) await writeCheckpoint(run, result.snapshot, result.sequence)
          } catch (err) {
            status(runId).lastError = (err as Error).message
          }
        }
        deliver(run, { type: 'ended' })
        releaseDrains(run)
        runs.delete(runId)
      })().finally(() => closing.delete(runId))
      closing.set(runId, done)
      return done
    },

    async history(sessionId: string, runId: string): Promise<CheckpointRead> {
      await closing.get(runId)
      return options.checkpoints.read(sessionId, runId)
    },

    async historyPreview(sessionId: string, runId: string): Promise<PreviewResult> {
      if (inspections >= 2) return { state: 'unavailable', reason: 'Geçmiş yükleme meşgul; tekrar deneyin' }
      inspections += 1
      try {
        await closing.get(runId)
        const stored = await options.checkpoints.read(sessionId, runId)
        if (stored.state === 'missing') {
          return { state: 'unavailable', reason: 'Bu Run için saklanmış terminal görüntüsü yok' }
        }
        if (stored.state === 'unreadable') {
          return { state: 'unavailable', reason: `Saklanmış görüntü okunamadı: ${stored.reason}` }
        }
        try {
          const preview = await request<Preview>(
            (requestId) => ({
              type: 'inspect',
              requestId,
              text: stored.checkpoint.text,
              cols: stored.checkpoint.cols,
              rows: stored.checkpoint.rows,
            }),
            runId,
          )
          return { state: 'ready', preview }
        } catch (err) {
          return { state: 'unavailable', reason: (err as Error).message }
        }
      } finally {
        inspections -= 1
      }
    },

    async publish(sessionId: string, runId: string): Promise<void> {
      const run = runs.get(runId)
      if (run) run.published = true
      // Run commit'ten önce çıkmış olabilir: son yazım bitsin, sonra budansın.
      await closing.get(runId)
      try {
        options.checkpoints.prune(sessionId, runId)
      } catch (err) {
        status(runId).lastError = (err as Error).message
      }
    },

    async discard(sessionId: string, runId: string): Promise<void> {
      await this.close(runId)
      options.checkpoints.removeRun(sessionId, runId)
      checkpointStatus.delete(runId)
    },

    removeSession(sessionId: string): void {
      options.checkpoints.removeSession(sessionId)
    },

    listRuns(sessionId: string): StoredRun[] {
      return options.checkpoints.list(sessionId)
    },

    failure(runId: string): TerminalFailure | null {
      return runs.get(runId)?.failure ?? null
    },

    checkpointStatus(runId: string): CheckpointStatus {
      const entry = checkpointStatus.get(runId)
      return entry ? { ...entry } : { lastSuccessAt: null, lastError: null }
    },

    async shutdown(): Promise<void> {
      for (const runId of [...runs.keys()]) await this.close(runId)
      const current = worker
      worker = null
      await current?.terminate()
    },
  }
}
