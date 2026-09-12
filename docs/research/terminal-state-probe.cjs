// AgentDeck terminal state kararı için dar doğrulama.
// Koşum: depo kökünden `node docs/research/terminal-state-probe.cjs`.
// @xterm/headless ve @xterm/addon-serialize artık depo devDependency'si (sabit sürüm).
// CLI hesabı veya model çağrısı gerekmez.
const {Terminal}=require('@xterm/headless');
const {SerializeAddon}=require('@xterm/addon-serialize');
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const make=(cols=80,rows=24)=>{const t=new Terminal({cols,rows,scrollback:1000,allowProposedApi:true});const s=new SerializeAddon();t.loadAddon(s);return {t,s};};
const write=(t,s)=>new Promise(r=>t.write(s,r));
const screen=t=>{const b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'');};
const line0=t=>{const b=t.buffer.active;return b.getLine(b.baseY)?.translateToString(true)||'';};
const fgAt=(t,x)=>{const b=t.buffer.active;const l=b.getLine(b.baseY);const c=l&&l.getCell(x);return c?c.getFgColor():null;};

// Emülatöre yalnız tamamlanmış kontrol dizilerine kadar veri ver; yarım kalan
// son ESC prefix'ini bir sonraki yazıma devret. Gösterim amaçlı sınırlı tarayıcı:
// ürün uygulaması DCS/SOS/PM/APC ve 8-bit C1 kapsamını da test etmelidir.
const safeCut=(s)=>{
  const i=s.lastIndexOf('\x1b');
  if(i<0) return s.length;
  const rest=s.slice(i);
  if(/^\x1b\[[0-9;:<>?!"'$ ]*[@-~]/.test(rest)) return s.length;          // tamamlanmış CSI
  if(/^\x1b[\]P^_][\s\S]*?(\x07|\x1b\\)/.test(rest)) return s.length;      // sonlanmış OSC/DCS/PM/APC
  if(/^\x1b[()*+#][\s\S]/.test(rest)) return s.length;                     // charset seçimi
  if(/^\x1b[0-9A-Za-z=><\\]/.test(rest)) return s.length;                  // tek karakterli ESC
  return i;                                                               // yarım: beklet
};

(async()=>{
  const out={};

  // 1) Sütun konumlandırması: ANSI silmek kelimeleri birleştirir, hücre okuması korur.
  const a=make();
  await write(a.t,'\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:');
  assert.equal(screen(a.t)[0],' Quick safety check:');

  // 2) Normal + alternate buffer, bracketed paste, sonra yalnız küçük bir bölgeyi
  //    güncelleyen yoğun çıktı.
  await write(a.t,'\r\n'+'normal log\r\n'.repeat(50)+'\x1b[?1049h\x1b[2J\x1b[HHEADER\x1b[5;1Hwaiting for input\x1b[?2004h');
  const flood='\x1b[10;1Htick'.repeat(30000);
  await write(a.t,flood);

  // 3) Son 256 KiB'yi boş terminale oynatmak referans ekranı kurmaz.
  const bytes=Buffer.from(flood);
  const tail=make();
  await write(tail.t,bytes.subarray(-262144).toString('utf8'));
  assert.notDeepEqual(screen(a.t),screen(tail.t));

  // 4) Serialize snapshot ekranı, buffer türünü, imleci ve modları geri kurar.
  const b=make();
  const start=performance.now();
  const snapshot=a.s.serialize({scrollback:1000});
  await write(b.t,snapshot);
  assert.deepEqual(screen(a.t),screen(b.t));
  assert.equal(b.t.buffer.active.type,'alternate');
  assert.equal(a.t.buffer.active.cursorX,b.t.buffer.active.cursorX);
  assert.equal(a.t.buffer.active.cursorY,b.t.buffer.active.cursorY);
  assert.deepEqual(a.t.modes,b.t.modes);
  await write(a.t,'\x1b[?1049l'); await write(b.t,'\x1b[?1049l');
  assert.deepEqual(screen(a.t),screen(b.t));
  out.snapshotBytes=Buffer.byteLength(snapshot);
  out.snapshotRoundtripMs=Math.round(performance.now()-start);
  out.floodBytes=bytes.length;
  out.ansiStripPreview=screen(tail.t)[0];

  // 5) Bariyer yarım kontrol dizisinin ortasına düşerse snapshot bozulur.
  const pc=make(40,5); await write(pc.t,'ABCD\x1b[3');
  const pcSnap=pc.s.serialize({scrollback:100});
  const pcR=make(40,5); await write(pcR.t,pcSnap);
  await write(pc.t,'1mRED'); await write(pcR.t,'1mRED');
  out.naiveBarrier={reference:line0(pc.t),restored:line0(pcR.t),referenceFg:fgAt(pc.t,4),restoredFg:fgAt(pcR.t,4)};
  assert.notEqual(line0(pc.t),line0(pcR.t));   // beklenen başarısızlık

  const po=make(40,5); await write(po.t,'XY\x1b]0;my-ti');
  const poSnap=po.s.serialize({scrollback:100});
  const poR=make(40,5); await write(poR.t,poSnap);
  await write(po.t,'tle\x07ZZ'); await write(poR.t,'tle\x07ZZ');
  out.naiveBarrierOSC={reference:line0(po.t),restored:line0(poR.t)};
  assert.notEqual(line0(po.t),line0(poR.t));   // OSC gövdesi ekrana sızar

  // 6) Güvenli kesim + bekletilen prefix aktarımı bozulmayı giderir.
  const stream=['ABCD\x1b[3','1mRED','\x1b]0;my-ti','tle\x07 ok'];
  const ref=make(40,5);
  for(const c of stream) await write(ref.t,c);
  let pending='', cur=make(40,5);
  for(const chunk of stream){
    const buf=pending+chunk;
    const cut=safeCut(buf);
    await write(cur.t,buf.slice(0,cut));
    pending=buf.slice(cut);
    const snap=cur.s.serialize({scrollback:100});   // bariyer güvenli sınırda
    const next=make(40,5);
    await write(next.t,snap);
    await write(next.t,pending);                    // replay sonrası ilk devam verisi
    cur.t.dispose(); cur=next; pending='';
  }
  assert.equal(line0(ref.t),line0(cur.t));
  assert.equal(fgAt(ref.t,4),fgAt(cur.t,4));
  out.safeCutBarrier={reference:line0(ref.t),restored:line0(cur.t),fg:fgAt(cur.t,4),result:'passed'};

  // 7) UTF-8 kod noktasını parça sınırında bölmek içeriği bozar.
  const u=make(40,5); const euro=Buffer.from('€');
  await write(u.t,'U');
  await write(u.t,euro.subarray(0,2).toString('utf8'));
  await write(u.t,euro.subarray(2).toString('utf8'));
  out.splitCodePoint={line:line0(u.t),note:'parça sınırı kod noktasını bölmemeli'};
  assert.notEqual(line0(u.t),'U€');

  console.log(JSON.stringify(out,null,1));
  for(const x of [a,b,tail,pc,pcR,po,poR,ref,cur,u]) x.t.dispose();
})().catch(e=>{console.error(e);process.exitCode=1;});
