// Kart önizlemesinin gerçek ajan TUI çıktısında okunabilir olup olmadığını ölçer.
//
// Kurulum (izole dizinde):
//   npm i @xterm/headless@6.0.0
//   node preview-readability-probe.cjs <yakalanan.raw> [...]
//
// Girdi dosyaları gerçek bir PTY'de çalıştırılan CLI'ın ham çıktısıdır
// (TERM=xterm-256color, 100x30). Yakalama yöntemi doğrulama notunda.
//
// Karşılaştırılan iki yöntem:
//   A) naif ANSI temizliği  — eski sözleşmenin önerdiği yol
//   B) headless ekran modelinin görünür satırları — yeni sözleşmenin yolu
const {Terminal} = require('@xterm/headless')
const fs = require('node:fs')
const path = require('node:path')

const COLS = 100, ROWS = 30, PREVIEW_LINES = 8, PREVIEW_BYTES = 2048

// A) Naif: kontrol dizilerini sil, kalanı metin say.
function naivePreview(raw) {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b./g, '')
    .split(/\r?\n/).filter(l => l.trim()).slice(-PREVIEW_LINES).join('\n')
}

// B) Ekran modeli: görünür viewport'un son boş olmayan satırları.
function screenPreview(raw) {
  return new Promise(resolve => {
    const t = new Terminal({cols: COLS, rows: ROWS, scrollback: 1000, allowProposedApi: true})
    t.write(raw, () => {
      const b = t.buffer.active
      const lines = []
      for (let i = 0; i < t.rows; i++) lines.push(b.getLine(b.baseY + i)?.translateToString(true).trimEnd() || '')
      let out = lines.filter(l => l.trim()).slice(-PREVIEW_LINES).join('\n')
      if (Buffer.byteLength(out) > PREVIEW_BYTES) out = out.slice(0, PREVIEW_BYTES)
      t.dispose(); resolve(out)
    })
  })
}

// Okunabilirlik ölçütü: yapışık kelime öbeği sayısı.
// Ajan CLI'ları kelimeleri boşlukla değil sütun konumlandırmasıyla yazdığı için
// naif ANSI temizliği bitişik öbekler üretir. Boşluk oranı ölçüt olarak
// kullanılamaz: naif çıktıdaki kutu çizgisi artıkları oranı yapay olarak şişirir.
// 18+ harfli boşluksuz öbek, doğal dilde pratikte görülmez.
function wordStats(text) {
  const glued = text.match(/[A-Za-zÇĞİÖŞÜçğıöşü]{18,}/g) || []
  return {yapışıkÖbek: glued.length, örnek: glued.slice(0, 2)}
}

;(async () => {
  const files = process.argv.slice(2)
  if (!files.length) { console.error('kullanım: node preview-readability-probe.cjs <dosya.raw> [...]'); process.exit(2) }
  let fail = 0
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8')
    const a = naivePreview(raw), b = await screenPreview(raw)
    const sa = wordStats(a), sb = wordStats(b)
    // Geçme koşulu: ekran modeli her CLI'da okunabilir olmalı.
    // Naif yöntemin bozulup bozulmadığı bilgilendirmedir: CLI'ın çizim
    // tarzına bağlıdır ve her CLI'da bozulmaz.
    const ok = sb.yapışıkÖbek === 0
    if (!ok) fail++
    console.log('='.repeat(76))
    console.log(path.basename(f), '| ham', Buffer.byteLength(raw), 'B')
    console.log('-- A) naif ANSI temizliği --'); console.log(a.slice(-400))
    console.log('   ', JSON.stringify(sa))
    console.log('-- B) headless ekran modeli --'); console.log(b.slice(-400))
    console.log('   ', JSON.stringify(sb))
    console.log('   SONUÇ:', ok ? 'ekran modeli OKUNABİLİR' : 'ekran modeli OKUNAMAZ',
                '| naif yöntem:', sa.yapışıkÖbek > 0 ? 'bozuluyor' : 'bu CLI\'da bozulmuyor')
  }
  console.log('='.repeat(76))
  console.log(fail ? `BAŞARISIZ: ${fail} dosyada ekran modeli okunamadı` : 'TÜM DOSYALARDA EKRAN MODELİ OKUNABİLİR')
  process.exitCode = fail ? 1 : 0
})()
