// AgentDeck terminal protokol kararları için doğrulama.
// Koşum: depo kökünden `node docs/research/terminal-protocol-probe.cjs`.
// @xterm/headless ve @xterm/addon-serialize artık depo devDependency'si (sabit sürüm).
// Kapsam: sekans sınıfı kapsamı, terminal sorgu sahipliği, sorgu ayıklamanın
// görsel kayıpsızlığı, iki katmanlı snapshot. CLI hesabı gerekmez.
const {Terminal} = require('@xterm/headless')
const {SerializeAddon} = require('@xterm/addon-serialize')
const assert = require('node:assert/strict')
const {performance} = require('node:perf_hooks')

const write = (t, s) => new Promise(r => t.write(s, r))
const mk = (cols = 60, rows = 6, sb = 100) => {
  const t = new Terminal({cols, rows, scrollback: sb, allowProposedApi: true})
  const s = new SerializeAddon(); t.loadAddon(s); return {t, s}
}
const line0 = t => { const b = t.buffer.active; return b.getLine(b.baseY)?.translateToString(true) || '' }
const screen = t => { const b = t.buffer.active; return Array.from({length: t.rows}, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) || '') }

// --- Üretim adayı güvenli kesim tarayıcısı -----------------------------------
// Tamamlanmış son kontrol dizisinin bittiği sınırı döner; yarım kalan prefix
// emülatöre verilmez. 7-bit ESC ve 8-bit C1 giriş noktalarını kapsar.
const MAX_PENDING = 4096
function safeCut(s) {
  let i = -1
  for (let k = s.length - 1; k >= 0 && s.length - k <= MAX_PENDING; k--) {
    const c = s.charCodeAt(k)
    if (c === 0x1b || (c >= 0x90 && c <= 0x9f)) { i = k; break }
  }
  if (i < 0) return s.length
  const r = s.slice(i)
  const c1 = r.charCodeAt(0)
  // 8-bit C1'i 7-bit eşdeğerine indirge, tek kod yolu kalsın
  const body = c1 === 0x1b ? r.slice(1)
    : String.fromCharCode(({0x90: 0x50, 0x98: 0x58, 0x9b: 0x5b, 0x9c: 0x5c, 0x9d: 0x5d, 0x9e: 0x5e, 0x9f: 0x5f})[c1] ?? 0x40) + r.slice(1)
  const k = body[0]
  if (k === undefined) return i                                             // yalnız ESC/C1
  if (k === '[') return /^\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/.test(body) ? s.length : i
  if (']PX^_'.includes(k)) return /[\x07]|\x1b\\|\x9c/.test(body.slice(1)) ? s.length : i
  if ('()*+#%'.includes(k)) return body.length >= 2 ? s.length : i
  return s.length                                                           // tek karakterli ESC
}

// --- Sunucu tarafı sorgu ayıklama -------------------------------------------
// Bu diziler ekrana bir şey çizmez; yalnız cevap üretir. Giden akıştan
// çıkarılınca tarayıcı terminali otomatik cevap üretmez.
const QUERY = /\x1b\[(?:\?[0-9;]*)?(?:>[0-9;]*)?[0-9;]*[cn]|\x1b\[>[0-9;]*q|\x1b\][0-9]+;\?(?:\x07|\x1b\\)/g
const stripQueries = s => s.replace(QUERY, '')

;(async () => {
  const out = {}

  // 1) Sekans sınıfı kapsamı: her sınıfta yarım kesim + bekletilen prefix ile
  //    kurulan ekran, kesintisiz referansa eşit olmalı.
  const cases = [
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
  ]
  out.sekansKapsami = []
  for (const [ad, head, tail] of cases) {
    const ref = mk(); await write(ref.t, head); await write(ref.t, tail)
    const cut = safeCut(head)
    const cur = mk(); await write(cur.t, head.slice(0, cut))
    const pending = head.slice(cut)
    const snap = cur.s.serialize({scrollback: 0})
    const restored = mk(); await write(restored.t, snap); await write(restored.t, pending + tail)
    assert.equal(line0(restored.t), line0(ref.t), 'sekans sınıfı başarısız: ' + ad)
    out.sekansKapsami.push({durum: ad, bekletilenBayt: pending.length, eşit: true})
  }

  // 2) Terminal sorgu sahipliği: headless terminal DA/DSR'ye cevap üretir.
  const q = mk(80, 24); const answers = []
  q.t.onData(d => answers.push(d))
  for (const seq of ['\x1b[c', '\x1b[>c', '\x1b[6n', '\x1b[5n']) await write(q.t, seq)
  await new Promise(r => setTimeout(r, 40))
  assert.ok(answers.length >= 4, 'headless terminal sorgulara cevap üretmedi')
  out.sorguSahipligi = {üretilenCevap: answers.length, örnek: answers.map(a => JSON.stringify(a))}

  // 3) Cevap zamanlaması: write() döndükten SONRA, write callback'inden ÖNCE.
  //    Bu yüzden istemcide senkron "write içindeyim" bayrağı güvenilir değildir.
  const seqLog = []
  const w = mk(80, 24)
  w.t.onData(() => seqLog.push('cevap'))
  w.t.write('x\x1b[cy', () => seqLog.push('callback'))
  seqLog.push('write-döndü')
  await new Promise(r => setTimeout(r, 50))
  assert.deepEqual(seqLog, ['write-döndü', 'cevap', 'callback'])
  out.cevapZamanlamasi = {sıra: seqLog, sonuç: 'istemci tarafı senkron bayrak çalışmaz'}

  // 4) Sorgu ayıklama görsel olarak kayıpsız; tarayıcı terminali susar.
  const stream = 'satır1\r\n\x1b[32mrenkli\x1b[39m\x1b[cdevam\r\n\x1b[6nson\x1b[31m!\x1b[39m'
  const A = mk(); const aAns = []; A.t.onData(d => aAns.push(d)); await write(A.t, stream)
  const B = mk(); const bAns = []; B.t.onData(d => bAns.push(d)); await write(B.t, stripQueries(stream))
  await new Promise(r => setTimeout(r, 40))
  assert.deepEqual(screen(B.t), screen(A.t), 'sorgu ayıklama ekranı değiştirdi')
  assert.ok(aAns.length > 0); assert.equal(bAns.length, 0)
  B.t.input('x'); await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(bAns, ['x'], 'kullanıcı girdisi geçmedi')
  out.sorguAyiklama = {ekranEşit: true, daemonCevabı: aAns.length, tarayıcıOtomatikCevabı: 0, kullanıcıGirdisiGeçiyor: true}

  // 5) İki katmanlı snapshot: yalnız ekran vs tam scrollback.
  const LINE = '\x1b[32m[info]\x1b[39m compiling module ' + 'x'.repeat(90) + '\r\n'
  const big = mk(120, 32, 1000)
  await write(big.t, LINE.repeat(3000))
  await write(big.t, '\x1b[?1049h\x1b[2J\x1b[HHEADER\x1b[5;1H\x1b[33mwaiting\x1b[39m\x1b[?2004h')
  const t0 = performance.now(); const screenOnly = big.s.serialize({scrollback: 0}); const msScreen = performance.now() - t0
  const t1 = performance.now(); const full = big.s.serialize({scrollback: 1000}); const msFull = performance.now() - t1
  const r1 = mk(120, 32, 1000); await write(r1.t, screenOnly)
  assert.deepEqual(screen(r1.t), screen(big.t), 'yalnız-ekran snapshot ekranı kurmadı')
  assert.equal(r1.t.buffer.active.type, 'alternate')
  assert.equal(r1.t.buffer.active.cursorX, big.t.buffer.active.cursorX)
  assert.equal(r1.t.buffer.active.cursorY, big.t.buffer.active.cursorY)
  assert.deepEqual(r1.t.modes, big.t.modes)
  await write(big.t, '\x1b[?1049l'); await write(r1.t, '\x1b[?1049l')
  assert.deepEqual(screen(r1.t), screen(big.t), 'alternate ekrandan çıkışta normal buffer görünümü ayrıştı')
  out.ikiKatmanliSnapshot = {
    yalnızEkran_KB: Math.round(Buffer.byteLength(screenOnly) / 1024 * 10) / 10,
    tamScrollback_KB: Math.round(Buffer.byteLength(full) / 1024),
    yalnızEkran_ms: Math.round(msScreen * 100) / 100,
    tamScrollback_ms: Math.round(msFull * 100) / 100,
    ekranDoğru: 'alternate + imleç + modlar + alt ekrandan çıkış',
  }

  console.log(JSON.stringify(out, null, 1))
  console.log('\nTÜM PROTOKOL ASSERTION\'LARI GEÇTİ')
})().catch(e => { console.error('BAŞARISIZ:', e.message); process.exitCode = 1 })
