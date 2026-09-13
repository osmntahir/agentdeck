import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { Terminal } from '@xterm/headless'
import { openCheckpointStore } from '../src/server/checkpoints'
import {
  createTerminalHost,
  type TerminalEvent,
  type TerminalHost,
  type TerminalHostOptions,
} from '../src/server/terminalHost'
import { removeDir, tempDir } from './helpers'

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r))

function screenOf(t: Terminal): string[] {
  const b = t.buffer.active
  return Array.from({ length: t.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '')
}

/** İstemcinin yaptığı iş: snapshot'ı yaz, sonra olayları sırayla uygula. */
async function clientScreen(snapshotText: string, events: TerminalEvent[], cols = 60, rows = 8): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
  await write(term, snapshotText)
  for (const event of events) {
    if (event.type === 'output') await write(term, event.text)
  }
  return term
}

interface Harness {
  host: TerminalHost
  dir: string
  close(): Promise<void>
}

function harness(overrides: Omit<Partial<TerminalHostOptions>, 'checkpoints'> = {}): Harness {
  const dir = tempDir()
  const host = createTerminalHost({ checkpoints: openCheckpointStore(dir), ...overrides })
  return {
    host,
    dir,
    async close() {
      await host.shutdown()
      removeDir(dir)
    },
  }
}

test('attach sırasındaki snapshot ve sonraki olaylar kesintisiz akışa eşit ekran kurar', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    h.host.feed('r1', 'birinci satır\r\n\x1b[32myeşil\x1b[39m\r\n')
    h.host.feed('r1', 'ikinci satır\r\n')

    const events: TerminalEvent[] = []
    const attachment = h.host.attach('r1', (e) => events.push(e))
    assert.ok(attachment)
    const replay = await attachment.snapshot('screen')

    // Snapshot alındıktan sonra gelen çıktı kaybolmadan aboneye iner.
    h.host.feed('r1', 'üçüncü satır\r\n')
    attachment.resume()
    await h.host.drain('r1')
    await new Promise((r) => setTimeout(r, 20))

    const reference = new Terminal({ cols: 60, rows: 8, scrollback: 100, allowProposedApi: true })
    await write(reference, 'birinci satır\r\n\x1b[32myeşil\x1b[39m\r\nikinci satır\r\nüçüncü satır\r\n')

    const restored = await clientScreen(replay.snapshot.text, events)
    assert.deepEqual(screenOf(restored), screenOf(reference))
    assert.ok(replay.sequence >= 2, `bariyer sırası: ${replay.sequence}`)
    attachment.close()
  } finally {
    await h.close()
  }
})

test('snapshot bariyerinden önceki olaylar aboneye tekrar verilmez', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    const events: TerminalEvent[] = []
    const attachment = h.host.attach('r1', (e) => events.push(e))
    assert.ok(attachment)

    // Attach ile snapshot arasında akan veri: snapshot'ın içinde olmalı,
    // abonelik kuyruğunda tekrar edilmemeli.
    h.host.feed('r1', 'ÖNCE')
    const replay = await attachment.snapshot('screen')
    h.host.feed('r1', 'SONRA')
    attachment.resume()
    await h.host.drain('r1')
    await new Promise((r) => setTimeout(r, 20))

    const delivered = events.filter((e) => e.type === 'output').map((e) => (e.type === 'output' ? e.text : ''))
    assert.equal(delivered.join(''), 'SONRA')
    assert.match(replay.snapshot.text, /ÖNCE/)
    attachment.close()
  } finally {
    await h.close()
  }
})

test('Run başına in-flight bütçesi aşılınca PTY duraklatılır ve boşalınca sürer', async () => {
  const paused: string[] = []
  const resumed: string[] = []
  const h = harness()
  try {
    h.host.open({
      sessionId: 's1',
      runId: 'r1',
      cols: 60,
      rows: 8,
      onPause: () => paused.push('r1'),
      onResume: () => resumed.push('r1'),
    })
    const block = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 40; i++) h.host.feed('r1', block)
    assert.ok(paused.length > 0, 'bütçe aşıldığı hâlde üretici duraklatılmadı')

    await h.host.drain('r1')
    assert.ok(resumed.length > 0, 'kuyruk boşaldığı hâlde üretici sürdürülmedi')
  } finally {
    await h.close()
  }
})

test('gürültülü Run sessiz Run u aç bırakmaz', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'gürültülü', cols: 60, rows: 8 })
    h.host.open({ sessionId: 's2', runId: 'sessiz', cols: 60, rows: 8 })

    const order: string[] = []
    const a = h.host.attach('gürültülü', (e) => e.type === 'output' && order.push('gürültülü'))
    const b = h.host.attach('sessiz', (e) => e.type === 'output' && order.push('sessiz'))
    a?.resume()
    b?.resume()

    // Tur bütçesi (256 KiB) aşılacak kadar çıktı: gürültülü Run bir turda
    // bitiremez, sıra sessiz Run'a gelmelidir.
    for (let i = 0; i < 60; i++) h.host.feed('gürültülü', 'satır\r\n'.repeat(1200))
    h.host.feed('sessiz', 'tek satır\r\n')

    await Promise.all([h.host.drain('gürültülü'), h.host.drain('sessiz')])
    await new Promise((r) => setTimeout(r, 20))

    const quietAt = order.indexOf('sessiz')
    assert.ok(quietAt >= 0, 'sessiz Run un çıktısı hiç işlenmedi')
    assert.ok(quietAt < order.length - 1, 'sessiz Run yalnız gürültülü Run bittikten sonra işlendi')
    a?.close()
    b?.close()
  } finally {
    await h.close()
  }
})

test('resize önce emülatöre uygulanır ve yeni boyut sıra numarasıyla bildirilir', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    const events: TerminalEvent[] = []
    const attachment = h.host.attach('r1', (e) => events.push(e))
    attachment?.resume()

    const applied = await h.host.resize('r1', 100, 30)
    assert.deepEqual({ cols: applied?.cols, rows: applied?.rows }, { cols: 100, rows: 30 })

    const replay = await attachment!.snapshot('screen')
    assert.equal(replay.snapshot.cols, 100)
    assert.equal(replay.snapshot.rows, 30)
    assert.ok(events.some((e) => e.type === 'resize' && e.cols === 100))
    attachment?.close()
  } finally {
    await h.close()
  }
})

test('sınır dışı boyutlar sözleşme aralığına kısılır', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    const applied = await h.host.resize('r1', 5000, 0)
    assert.deepEqual({ cols: applied?.cols, rows: applied?.rows }, { cols: 300, rows: 1 })
  } finally {
    await h.close()
  }
})

test('preview ekran modeli hazır olmadan hazır denmez', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    assert.equal((await h.host.preview('r1')).state, 'preparing')

    h.host.feed('r1', 'ajan çalışıyor\r\n')
    await h.host.drain('r1')
    const ready = await h.host.preview('r1')
    assert.equal(ready.state, 'ready')
    assert.match(ready.preview?.text ?? '', /ajan çalışıyor/)

    assert.equal((await h.host.preview('bilinmeyen')).state, 'unavailable')
  } finally {
    await h.close()
  }
})

test('daemon terminalinin ürettiği cevap PTY ye gider', async () => {
  const replies: string[] = []
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8, onReply: (d) => replies.push(d) })
    h.host.feed('r1', '\x1b[6n')
    await h.host.drain('r1')
    await new Promise((r) => setTimeout(r, 60))
    assert.ok(replies.length > 0, 'sorgunun cevabı üretilmedi')
    assert.match(replies.join(''), /\x1b\[\d+;\d+R/)
  } finally {
    await h.close()
  }
})

test('kapanışta checkpoint yazılır ve geçmiş görüntüsü geri okunur', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    h.host.feed('r1', 'iş bitti\r\n')
    await h.host.close('r1')

    const read = await h.host.history('s1', 'r1')
    assert.equal(read.state, 'ready')
    if (read.state !== 'ready') return
    assert.match(read.checkpoint.text, /iş bitti/)
    assert.ok(h.host.checkpointStatus('r1').lastSuccessAt !== null)
  } finally {
    await h.close()
  }
})

test('kirlenen terminal yaklaşık bir saniyede kendiliğinden flush edilir', async () => {
  const h = harness({ checkpointDelayMs: 40 })
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    h.host.feed('r1', 'ara kayıt\r\n')
    await new Promise((r) => setTimeout(r, 250))
    const read = await h.host.history('s1', 'r1')
    assert.equal(read.state, 'ready', 'zamanlanmış flush çalışmadı')
  } finally {
    await h.close()
  }
})

test('worker çökerse temsil hatası bildirilir, sahte snapshot üretilmez', async () => {
  const workers: Worker[] = []
  const h = harness({
    spawnWorker: (createDefault) => {
      const worker = createDefault()
      workers.push(worker)
      return worker
    },
  })
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    const events: TerminalEvent[] = []
    const attachment = h.host.attach('r1', (e) => events.push(e))
    attachment?.resume()
    h.host.feed('r1', 'merhaba')
    await h.host.drain('r1')

    await workers[0].terminate()
    await new Promise((r) => setTimeout(r, 100))

    assert.equal(h.host.failure('r1')?.code, 'engine_error')
    assert.ok(events.some((e) => e.type === 'failure'))
    await assert.rejects(() => attachment!.snapshot('screen'), /temsil|terminal/i)
  } finally {
    await h.close()
  }
})

test('scrollback katmanı ekran katmanından ayrı ve daha büyüktür', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    for (let i = 0; i < 200; i++) h.host.feed('r1', `geçmiş satır ${i}\r\n`)
    await h.host.drain('r1')

    const attachment = h.host.attach('r1', () => {})
    const screen = await attachment!.snapshot('screen')
    const full = await attachment!.snapshot('scrollback')
    assert.equal(screen.snapshot.scope, 'screen')
    assert.equal(full.snapshot.scope, 'scrollback')
    assert.ok(full.snapshot.totalBytes > screen.snapshot.totalBytes * 2)
    attachment?.close()
  } finally {
    await h.close()
  }
})

test('canlı olmayan Run un kart önizlemesi saklanmış görüntüden kurulur', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    h.host.feed('r1', 'derleme bitti\r\n\x1b[32mbaşarılı\x1b[39m\r\n')
    await h.host.close('r1')

    const preview = await h.host.historyPreview('s1', 'r1')
    assert.equal(preview.state, 'ready')
    assert.match(preview.preview?.text ?? '', /derleme bitti[\s\S]*başarılı/)

    // Hiç kaydı olmayan Run "yok" der; uydurma ekran kurulmaz.
    const missing = await h.host.historyPreview('s1', 'yok')
    assert.equal(missing.state, 'unavailable')
    assert.match(missing.reason ?? '', /yok/)
  } finally {
    await h.close()
  }
})

test('aynı Run eşzamanlı kapatıldığında bütün çağrılar son checkpoint i bekler', { timeout: 5000 }, async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    h.host.feed('r1', 'son çıktı')
    await Promise.all([h.host.close('r1'), h.host.close('r1')])
    const stored = await h.host.history('s1', 'r1')
    assert.equal(stored.state, 'ready')
    if (stored.state === 'ready') assert.match(stored.checkpoint.text, /son çıktı/)
  } finally {
    await h.close()
  }
})

test('worker kaybı bekleyen resize ve kapanışı sonsuza kadar bekletmez', { timeout: 5000 }, async () => {
  let worker: Worker | undefined
  const h = harness({ spawnWorker: (create) => { worker = create(); return worker } })
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    const resizing = h.host.resize('r1', 80, 20)
    const closing = h.host.shutdown()
    await worker!.terminate()
    await Promise.all([resizing, closing])
  } finally { await h.close() }
})

test('ikinci snapshot alınırken devam olayları yeni bariyerin arkasında tutulur', async () => {
  const h = harness()
  try {
    h.host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    const events: TerminalEvent[] = []
    const a = h.host.attach('r1', (event) => events.push(event))!
    await a.snapshot('screen')
    a.resume()
    h.host.feed('r1', 'önce')
    await h.host.drain('r1')
    events.length = 0
    const replay = a.snapshot('scrollback')
    h.host.feed('r1', 'sonra')
    await replay
    await h.host.drain('r1')
    assert.equal(events.length, 0, 'replay sırasında canlı delta sızdı')
    a.resume()
    assert.equal(events.filter((e) => e.type === 'output').map((e) => e.text).join(''), 'sonra')
    a.close()
  } finally { await h.close() }
})

test('periyodik flush sürerken kapanış son çıktıyı onun ardından kaydeder', { timeout: 5000 }, async () => {
  const dir = tempDir()
  const store = openCheckpointStore(dir)
  let release!: () => void
  let started!: () => void
  const began = new Promise<void>((r) => { started = r })
  const gate = new Promise<void>((r) => { release = r })
  let count = 0
  const host = createTerminalHost({ checkpointDelayMs: 1, checkpoints: {
    ...store,
    async write(input) {
      if (count++ === 0) { started(); await gate }
      await store.write(input)
    },
  } })
  try {
    host.open({ sessionId: 's1', runId: 'r1', cols: 60, rows: 8 })
    host.feed('r1', 'ilk')
    await began
    host.feed('r1', ' son')
    const closing = host.close('r1')
    release()
    await closing
    const result = await host.history('s1', 'r1')
    assert.equal(result.state, 'ready')
    if (result.state === 'ready') assert.match(result.checkpoint.text, /ilk son/)
  } finally { release(); await host.shutdown(); removeDir(dir) }
})
