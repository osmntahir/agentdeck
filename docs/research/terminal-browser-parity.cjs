// Headless snapshot'ın gerçek tarayıcı xterm'inde aynı ekranı kurup kurmadığını ölçer.
//
// Kurulum (izole dizinde):
//   npm i @xterm/headless@6.0.0 @xterm/addon-serialize@0.14.0 @xterm/xterm@6.0.0
//   node terminal-browser-parity.cjs          # parity.html üretir
//   python3 -m http.server 8731 --bind 127.0.0.1
//   tarayıcıda http://127.0.0.1:8731/parity.html aç, konsolda [PARITY] satırını oku
//
// file:// ile açmak yerine localhost servis edilir; bazı tarayıcı otomasyonları
// file:// URL'lerine erişmez. xterm.js ve css sayfaya gömülür, ağ gerekmez.
const {Terminal} = require('@xterm/headless')
const {SerializeAddon} = require('@xterm/addon-serialize')
const fs = require('node:fs')

const write = (t, s) => new Promise(r => t.write(s, r))
const screen = t => { const b = t.buffer.active; return Array.from({length: t.rows}, (_, i) => b.getLine(b.baseY + i)?.translateToString(true) || '') }

;(async () => {
  const t = new Terminal({cols: 80, rows: 20, scrollback: 200, allowProposedApi: true})
  const s = new SerializeAddon(); t.loadAddon(s)

  // Gerçekçi ajan TUI ekranı: normal buffer geçmişi, alternate ekran, sütun
  // konumlandırma, truecolor, arka plan, wide/combining Unicode, stiller,
  // bracketed paste + application cursor modu ve belirli bir imleç konumu.
  await write(t, 'log line A\r\nlog line B\r\n'.repeat(20))
  await write(t, '\x1b[?1049h\x1b[2J\x1b[H')
  await write(t, '\x1b[1;1H\x1b[38;2;255;204;0m\x1b[1mAgentDeck\x1b[22m\x1b[39m test ekranı')
  await write(t, '\x1b[3;2HQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22Gaçık')
  await write(t, '\x1b[5;1H\x1b[48;5;24m seçili satır \x1b[49m')
  await write(t, '\x1b[7;1H地図 CJK genişlik | é combining | 🙂 emoji')
  await write(t, '\x1b[9;1H\x1b[4maltı çizili\x1b[24m \x1b[3mitalik\x1b[23m \x1b[7mters\x1b[27m')
  await write(t, '\x1b[?2004h\x1b[?1h')
  await write(t, '\x1b[12;5H')

  const fixture = {
    cols: t.cols, rows: t.rows,
    snapshot: s.serialize({scrollback: 0}),      // iki katmanlı attach: yalnız ekran
    screen: screen(t),
    cursorX: t.buffer.active.cursorX, cursorY: t.buffer.active.cursorY,
    bufferType: t.buffer.active.type, modes: t.modes,
  }
  t.dispose()

  const xtermJs = fs.readFileSync(require.resolve('@xterm/xterm/lib/xterm.js'), 'utf8')
  const xtermCss = fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8')
  const html = `<!doctype html><meta charset="utf-8"><title>xterm parity</title>
<style>${xtermCss}
body{background:#111;color:#eee;font-family:monospace;margin:0;padding:12px}
#term{width:900px} #out{white-space:pre-wrap;margin-top:12px;font-size:13px}</style>
<div id="term"></div><div id="out">çalışıyor…</div>
<script>${xtermJs}</script>
<script>
const FX = ${JSON.stringify(fixture)};
const term = new Terminal({cols:FX.cols, rows:FX.rows, scrollback:200, allowProposedApi:true});
term.open(document.getElementById('term'));
term.write(FX.snapshot, () => setTimeout(() => {
  const b = term.buffer.active;
  const got = Array.from({length:term.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'');
  const diffs = [];
  for (let i=0;i<FX.rows;i++) if (got[i]!==FX.screen[i]) diffs.push({row:i, headless:FX.screen[i], browser:got[i]});
  const modeDiffs = Object.keys(FX.modes).filter(k => JSON.stringify(FX.modes[k])!==JSON.stringify(term.modes[k]));
  const ok = diffs.length===0 && FX.bufferType===b.type && FX.cursorX===b.cursorX && FX.cursorY===b.cursorY && modeDiffs.length===0;
  const res = {satirEsit:diffs.length===0, farkliSatir:diffs,
    bufferTuru:{headless:FX.bufferType, browser:b.type},
    imlec:{headless:[FX.cursorX,FX.cursorY], browser:[b.cursorX,b.cursorY]},
    modFarki:modeDiffs, SONUC: ok ? 'PARITY_PASS' : 'PARITY_FAIL'};
  console.log('[PARITY] '+JSON.stringify(res));
  document.getElementById('out').textContent = JSON.stringify(res,null,1);
}, 200));
</script>`
  fs.writeFileSync('parity.html', html)
  console.log('parity.html yazıldı:', Math.round(html.length / 1024) + ' KB; snapshot', Buffer.byteLength(fixture.snapshot), 'B')
})()
