import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'
import {
  MAX_PENDING_BYTES,
  PREVIEW_BYTES,
  PREVIEW_LINES,
  TerminalState,
  chunkText,
  stripQueries,
} from '../src/server/terminalState'

const write = (t: Terminal, s: string) => new Promise<void>((r) => t.write(s, r))

function reference(cols = 60, rows = 6): Terminal {
  return new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
}

function screenOf(t: Terminal): string[] {
  const b = t.buffer.active
  return Array.from({ length: t.rows }, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) ?? '')
}

/** Snapshot'ın kurduğu ekran; istemcinin yaptığı işin sunucu tarafı karşılığı. */
async function restore(snapshotText: string, tail: string, cols = 60, rows = 6): Promise<Terminal> {
  const t = reference(cols, rows)
  await write(t, snapshotText)
  await write(t, tail)
  return t
}

/**
 * Sözleşmenin on iki sekans sınıfı (spec §4). Her sınıfta akış yarım kalan bir
 * kontrol dizisinin ortasında kesilir; kurulan ekran kesintisiz referansa eşit
 * olmalıdır. Kanıt script'i docs/research/terminal-protocol-probe.cjs.
 */
const SEQUENCE_CLASSES: [string, string, string][] = [
  ['tamamlanmamış CSI', 'A\x1b[3', '1mZ'],
  ['alt parametreli CSI', 'A\x1b[38:2:255:0', ':0mZ'],
  ['ara baytlı CSI', 'A\x1b[?25', 'hZ'],
  ['tamamlanmamış OSC', 'A\x1b]0;ti', 'tle\x07Z'],
  ['tamamlanmamış DCS', 'A\x1bPq#0;2;0', ';0;0\x1b\\Z'],
  ['APC', 'A\x1b_G f=1', ';data\x1b\\Z'],
  ['PM', 'A\x1b^abc', 'def\x1b\\Z'],
  ['8-bit CSI (C1)', 'A\x9b3', '1mZ'],
  ['8-bit OSC (C1)', 'A\x9d0;ti', 'tle\x9cZ'],
  ['charset seçimi', 'A\x1b(', 'BZ'],
  ['yalnız ESC', 'A\x1b', '[31mZ'],
  ['tek karakterli ESC', 'A\x1b7', 'Z'],
  // Geriye dönük "son ESC'i bul" taraması bu ikisini yanlış okur: kesim
  // noktası ST'nin ESC'ine denk geldiğinde yarım diziyi tam sanar.
  ['ST sınırında kesilen OSC', 'A\x1b]0;başlık\x1b', '\\Z'],
  ['ST sınırında kesilen DCS', 'A\x1bPq#0;2;0;0;0\x1b', '\\Z'],
]

for (const [label, head, tail] of SEQUENCE_CLASSES) {
  test(`güvenli kesim: ${label} sınıfında snapshot kesintisiz akışa eşit`, async () => {
    const ref = reference()
    await write(ref, head)
    await write(ref, tail)

    const state = new TerminalState({ cols: 60, rows: 6 })
    const first = await state.write(head)
    const snapshot = state.snapshot('screen')
    // Bekletilen prefix bir sonraki tamamlanan parçanın başında taşınır.
    const second = await state.write(tail)

    const restored = await restore(snapshot.text, second.text)
    assert.deepEqual(screenOf(restored), screenOf(ref), `${label}: kurulan ekran ayrıştı`)

    // Kesintisiz izleyici de aynı toplam girdiyi alır.
    const livePeer = reference()
    await write(livePeer, first.text)
    await write(livePeer, second.text)
    assert.deepEqual(screenOf(livePeer), screenOf(ref), `${label}: canlı izleyici akışı ayrıştı`)
    state.dispose()
  })
}

test('bekletilen prefix izleyici akışına iki kez yazılmaz', async () => {
  const state = new TerminalState({ cols: 60, rows: 6 })
  const first = await state.write('AB\x1b[3')
  assert.equal(first.text, 'AB', 'yarım kalan dizi izleyiciye sızmamalı')
  const second = await state.write('1mZ')
  assert.equal(second.text, '\x1b[31mZ', 'bekletilen prefix tam olarak bir kez taşınır')
  state.dispose()
})

test('bekleyen prefix 4096 baytı aşarsa temsil hatası olur ve snapshot yayımlanmaz', async () => {
  const state = new TerminalState({ cols: 60, rows: 6 })
  await state.write('\x1b]0;' + 'x'.repeat(MAX_PENDING_BYTES))
  assert.equal(state.failure?.code, 'pending_overflow')
  assert.throws(() => state.snapshot('screen'), /temsil/i, 'hatalı durumda snapshot üretilmez')
  state.dispose()
})

test('sorgu ayıklama görsel olarak kayıpsızdır ve tarayıcıya sorgu sızmaz', async () => {
  const stream = 'satır1\r\n\x1b[32mrenkli\x1b[39m\x1b[cdevam\r\n\x1b[6nson\x1b[31m!\x1b[39m'
  const ref = reference()
  await write(ref, stream)

  const state = new TerminalState({ cols: 60, rows: 6 })
  const out = await state.write(stream)
  assert.equal(out.text.includes('\x1b[c'), false)
  assert.equal(out.text.includes('\x1b[6n'), false)

  const viewer = reference()
  await write(viewer, out.text)
  assert.deepEqual(screenOf(viewer), screenOf(ref), 'ayıklanmış akış farklı ekran kurdu')
  state.dispose()
})

test('parçalar arasına bölünmüş sorgu da izleyiciye ulaşmaz', async () => {
  const state = new TerminalState({ cols: 60, rows: 6 })
  const a = await state.write('merhaba\x1b[6')
  const b = await state.write('nson')
  assert.equal(a.text + b.text, 'merhabason', 'bölünmüş DSR izleyici akışına sızdı')
  state.dispose()
})

test('daemon terminali sorgulara kendi cevabını üretir', async () => {
  const replies: string[] = []
  const state = new TerminalState({ cols: 80, rows: 24, onReply: (d) => replies.push(d) })
  await state.write('\x1b[c\x1b[>c\x1b[6n\x1b[5n')
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(replies.length >= 4, `cevap üretilmedi: ${replies.length}`)
  state.dispose()
})

test('preview görünür viewport un son boş olmayan satırlarından çıkar', async () => {
  const state = new TerminalState({ cols: 40, rows: 12 })
  for (let i = 1; i <= 20; i++) await state.write(`satır ${i} · iki kelime\r\n`)
  const preview = state.preview()
  const lines = preview.text.split('\n')
  assert.equal(lines.length, PREVIEW_LINES)
  assert.equal(lines[lines.length - 1], 'satır 20 · iki kelime')
  assert.equal(preview.truncated, false)
  assert.ok(preview.capturedAt > 0)
  state.dispose()
})

test('preview hücre boşluklarını korur; kelimeler yapışmaz', async () => {
  const state = new TerminalState({ cols: 40, rows: 6 })
  // Ajan TUI'ları kelimeleri boşlukla değil sütun konumlandırmasıyla yazar.
  await state.write('sol\x1b[20Gsağ\r\n')
  assert.match(state.preview().text, /^sol {16}sağ$/)
  state.dispose()
})

test('preview 2 KiB bütçesinde kesilir ve kesilme bildirilir', async () => {
  const state = new TerminalState({ cols: 300, rows: 30 })
  for (let i = 0; i < 12; i++) await state.write('y'.repeat(299) + '\r\n')
  const preview = state.preview()
  assert.ok(Buffer.byteLength(preview.text) <= PREVIEW_BYTES, 'bütçe aşıldı')
  assert.equal(preview.truncated, true)
  state.dispose()
})

test('yalnız ekran snapshot ı alternate buffer, imleç ve modları kurar', async () => {
  const state = new TerminalState({ cols: 60, rows: 6 })
  await state.write('geçmiş\r\n'.repeat(40))
  await state.write('\x1b[?1049h\x1b[2J\x1b[HBAŞLIK\x1b[4;1H\x1b[33mbekliyor\x1b[39m\x1b[?2004h')

  const screen = state.snapshot('screen')
  const full = state.snapshot('scrollback')
  assert.equal(screen.scope, 'screen')
  assert.equal(full.scope, 'scrollback')
  assert.ok(full.totalBytes > screen.totalBytes, 'scrollback katmanı ekran katmanından büyük olmalı')
  assert.equal(screen.cols, 60)
  assert.equal(screen.rows, 6)

  const restored = await restore(screen.text, '')
  assert.equal(restored.buffer.active.type, 'alternate')
  assert.equal(restored.modes.bracketedPasteMode, true)
  assert.match(screenOf(restored).join('\n'), /BAŞLIK/)
  state.dispose()
})

test('resize emülatöre uygulanır ve snapshot yeni boyutu taşır', async () => {
  const state = new TerminalState({ cols: 60, rows: 6 })
  await state.write('merhaba')
  state.resize(100, 30)
  const snapshot = state.snapshot('screen')
  assert.equal(snapshot.cols, 100)
  assert.equal(snapshot.rows, 30)
  state.dispose()
})

test('güvenli kesim vekil çiftini bölmez', async () => {
  const state = new TerminalState({ cols: 60, rows: 6 })
  const emoji = '🙂'
  const out = await state.write(`ab${emoji}`)
  assert.equal(out.text, `ab${emoji}`, 'vekil çifti bölündü')
  state.dispose()
})

test('stripQueries çizim yapan dizilere dokunmaz', () => {
  const drawing = '\x1b[31mkırmızı\x1b[0m\x1b[2J\x1b[H\x1b[?25l'
  assert.equal(stripQueries(drawing), drawing)
})

test('genişletilmiş sorgu kümesi de ekranı değiştirmez', async () => {
  // DECRQM, OSC renk sorgusu ve XTGETTCAP da cevap üretir, çizim yapmaz.
  const queries = '\x1b[?1049$p\x1b]4;1;?\x07\x1bP+q544e\x1b\\\x1b[>0q'
  const stream = `önce${queries}sonra`
  const ref = reference()
  await write(ref, 'öncesonra')

  const state = new TerminalState({ cols: 60, rows: 6 })
  const out = await state.write(stream)
  assert.equal(out.text, 'öncesonra', 'sorgular izleyici akışında kaldı')

  const viewer = reference()
  await write(viewer, out.text)
  assert.deepEqual(screenOf(viewer), screenOf(ref))
  state.dispose()
})

test('chunkText bayt bütçesine uyar ve vekil çiftini bölmez', () => {
  const text = 'a🙂b🙂c🙂'
  const chunks = chunkText(text, 5)
  assert.equal(chunks.join(''), text)
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk) <= 5, `parça bütçeyi aştı: ${Buffer.byteLength(chunk)}`)
    assert.equal(chunk.includes('�'), false)
    assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk, 'vekil çifti bölündü')
  }
  assert.deepEqual(chunkText('', 10), [])
})

test('DCS içindeki BEL güvenli kesim değildir; devam gövdesi ekrana sızmaz', async () => {
  const state = new TerminalState({ cols: 60, rows: 6 })
  const ref = reference()
  const viewer = reference()
  try {
    const head = 'ABC\x1bPqpayload\x07'
    const tail = 'more\x1b\\Z'
    await state.write(head)
    await write(viewer, state.snapshot('screen').text)
    await write(viewer, (await state.write(tail)).text)
    await write(ref, head + tail)
    assert.deepEqual(screenOf(viewer), screenOf(ref))
  } finally { state.dispose(); ref.dispose(); viewer.dispose() }
})

test('DECRQSS ve ANSI mode sorgularını yalnız daemon yanıtlar', async () => {
  const replies: string[] = []
  const viewerReplies: string[] = []
  const state = new TerminalState({ cols: 60, rows: 6, onReply: (data) => replies.push(data) })
  const viewer = reference()
  viewer.onData((data) => viewerReplies.push(data))
  try {
    const out = await state.write('A\x1bP$qm\x1b\\\x1b[4$pZ')
    await write(viewer, out.text)
    assert.equal(out.text, 'AZ')
    assert.ok(replies.length >= 2)
    assert.deepEqual(viewerReplies, [])
  } finally { state.dispose(); viewer.dispose() }
})
