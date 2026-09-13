import { parentPort } from 'node:worker_threads'
import { TerminalState, type Preview, type Snapshot, type SnapshotScope, type TerminalFailure } from './terminalState'

/**
 * Terminal-state worker'ı (spec §4). Ekran modeli HTTP/Git kontrol işlerinden
 * ayrı bir iş parçacığında yaşar: Run başına FIFO sıra, Run'lar arasında ise
 * sınırlı tur bütçesiyle dönülür. Gürültülü bir Run sessiz olanı aç bırakamaz.
 *
 * Bu dosya yalnız worker olarak yüklenir; ana iş parçacığı cephesi
 * `terminalHost.ts` içindedir.
 */

/** Bir Run'ın tek turda işleyebileceği bayt; aşınca sıra diğer Run'lara geçer. */
const ROUND_BUDGET_BYTES = 256 * 1024

export type WorkerRequest =
  | { type: 'open'; runId: string; cols: number; rows: number }
  | { type: 'write'; runId: string; sequence: number; chunk: string }
  | { type: 'resize'; runId: string; sequence: number; cols: number; rows: number }
  | { type: 'snapshot'; runId: string; requestId: number; scope: SnapshotScope }
  | { type: 'preview'; runId: string; requestId: number }
  | { type: 'close'; runId: string; requestId: number }
  /** Canlı olmayan bir Run'ın checkpoint'i: geçici modelde açılır, atılır. */
  | { type: 'inspect'; requestId: number; text: string; cols: number; rows: number }

export type WorkerEvent =
  | { type: 'output'; runId: string; sequence: number; text: string; cost: number }
  | { type: 'reply'; runId: string; data: string }
  | { type: 'resized'; runId: string; sequence: number; cols: number; rows: number }
  | { type: 'snapshot'; runId: string; requestId: number; snapshot: Snapshot; sequence: number }
  | { type: 'preview'; runId: string; requestId: number; preview: Preview }
  | { type: 'closed'; runId: string; requestId: number; snapshot: Snapshot | null; sequence: number }
  | { type: 'failure'; runId: string; failure: TerminalFailure }
  | { type: 'inspected'; requestId: number; preview: Preview }
  | { type: 'rejected'; runId: string; requestId: number; message: string }

interface RunEntry {
  state: TerminalState
  queue: WorkerRequest[]
  sequence: number
  failed: boolean
}

const port = parentPort
if (port) {
  const runs = new Map<string, RunEntry>()
  let pumping = false

  const post = (event: WorkerEvent): void => port.postMessage(event)

  function openRun(request: Extract<WorkerRequest, { type: 'open' }>): void {
    if (runs.has(request.runId)) return
    const runId = request.runId
    runs.set(runId, {
      state: new TerminalState({
        cols: request.cols,
        rows: request.rows,
        onReply: (data) => post({ type: 'reply', runId, data }),
      }),
      queue: [],
      sequence: 0,
      failed: false,
    })
  }

  /** Bir isteği uygular ve tur bütçesinden düşülecek maliyeti döner. */
  async function apply(runId: string, run: RunEntry, request: WorkerRequest): Promise<number> {
    switch (request.type) {
      case 'write': {
        run.sequence = request.sequence
        const cost = Buffer.byteLength(request.chunk)
        const result = await run.state.write(request.chunk)
        post({ type: 'output', runId, sequence: request.sequence, text: result.text, cost })
        reportFailure(runId, run)
        return cost
      }
      case 'resize': {
        run.sequence = request.sequence
        run.state.resize(request.cols, request.rows)
        post({
          type: 'resized',
          runId,
          sequence: request.sequence,
          cols: run.state.cols,
          rows: run.state.rows,
        })
        return 0
      }
      case 'snapshot': {
        try {
          post({
            type: 'snapshot',
            runId,
            requestId: request.requestId,
            snapshot: run.state.snapshot(request.scope),
            sequence: run.sequence,
          })
        } catch (err) {
          post({ type: 'rejected', runId, requestId: request.requestId, message: (err as Error).message })
        }
        return 0
      }
      case 'preview': {
        try {
          post({ type: 'preview', runId, requestId: request.requestId, preview: run.state.preview() })
        } catch (err) {
          post({ type: 'rejected', runId, requestId: request.requestId, message: (err as Error).message })
        }
        return 0
      }
      case 'close': {
        let snapshot: Snapshot | null = null
        try {
          snapshot = run.state.snapshot('scrollback')
        } catch {
          // Temsil hatası varsa sahte geçmiş yazılmaz.
        }
        run.state.dispose()
        runs.delete(runId)
        post({ type: 'closed', runId, requestId: request.requestId, snapshot, sequence: run.sequence })
        return 0
      }
      default:
        return 0
    }
  }

  function reportFailure(runId: string, run: RunEntry): void {
    const failure = run.state.failure
    if (failure && !run.failed) {
      run.failed = true
      post({ type: 'failure', runId, failure })
    }
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      let working = true
      while (working) {
        working = false
        for (const runId of [...runs.keys()]) {
          const run = runs.get(runId)
          if (!run) continue
          let budget = ROUND_BUDGET_BYTES
          while (run.queue.length > 0 && budget > 0) {
            const request = run.queue.shift() as WorkerRequest
            budget -= await apply(runId, run, request)
            working = true
            // close çağrısı Run'ı kaldırmış olabilir.
            if (!runs.has(runId)) break
          }
        }
      }
    } finally {
      pumping = false
    }
  }

  /**
   * Checkpoint incelemesi hiçbir canlı Run'ın sırasına girmez: geçici bir model
   * kurulur, önizleme alınır ve model hemen bırakılır. Eşzamanlılık tavanı
   * çağıran taraftadır.
   */
  async function inspect(request: Extract<WorkerRequest, { type: 'inspect' }>): Promise<void> {
    const state = new TerminalState({ cols: request.cols, rows: request.rows })
    try {
      await state.write(request.text)
      post({ type: 'inspected', requestId: request.requestId, preview: state.preview() })
    } catch (err) {
      post({ type: 'rejected', runId: '', requestId: request.requestId, message: (err as Error).message })
    } finally {
      state.dispose()
    }
  }

  port.on('message', (request: WorkerRequest) => {
    if (request.type === 'open') {
      openRun(request)
      return
    }
    if (request.type === 'inspect') {
      void inspect(request)
      return
    }
    const run = runs.get(request.runId)
    if (!run) {
      if ('requestId' in request) {
        post({ type: 'rejected', runId: request.runId, requestId: request.requestId, message: 'Run kapalı' })
      }
      return
    }
    run.queue.push(request)
    void pump()
  })
}
