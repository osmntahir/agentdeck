/**
 * Derlenmiş gerçek daemon + izole Chromium + geçici kabuk oturumları.
 * npm run build
 * PLAYWRIGHT_MODULE=/path/to/playwright node docs/research/adr-runtime-probe.cjs [--capacity]
 * CHROME_BIN ve ADR_PROBE_OUTPUT isteğe bağlıdır. Gerçek ajan trust/auth çalıştırmaz.
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert/strict');
const {startDaemon} = require(path.resolve(__dirname, '../../dist/server/daemon.js'));
(async () => {
 const output = process.env.ADR_PROBE_OUTPUT || path.join(os.tmpdir(), 'agentdeck-adr-probe'); fs.mkdirSync(output, {recursive:true});
 const root = fs.mkdtempSync(path.join(os.tmpdir(),'agentdeck-adr-qa-'));
 const repo = path.join(root,'repo'); fs.mkdirSync(repo);
 let daemon, browser;
 try {
  daemon = await startDaemon({dataDir:path.join(root,'data'),port:0,serveWeb:true});
  const post = async (route, body) => {
   const response = await fetch(daemon.url+route,{method:'POST',headers:{'X-Agentdeck-Token':daemon.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
   assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const project = await post('/api/projects',{path:repo});
  const sessions=[];
  for(const name of ['QA Alpha','QA Beta']) sessions.push(await post('/api/sessions',{requestId:name,projectId:project.id,name,command:'printf QA_READY; sleep 300',isolation:'shared'}));
  browser=await chromium.launch({executablePath:process.env.CHROME_BIN || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1280,height:900}}); const errors=[];
  page.on('pageerror', e=>errors.push(e.message));
  await page.goto(daemon.url+'/?token='+daemon.token);
  await page.locator('.session-row').first().waitFor();
  await page.getByRole('button',{name:"QA Alpha oturumunu terminal grid'e ekle",exact:true}).click();
  await page.getByRole('button',{name:"QA Beta oturumunu terminal grid'e ekle",exact:true}).click();
  const nav = page.getByRole('toolbar',{name:'Grid terminalleri'});
  await nav.getByRole('button',{name:'QA Alpha',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'QA Beta');
  assert.equal(await nav.locator('button[tabindex="0"]').count(),1);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.keyboard.press('F6');
  assert.ok(await page.evaluate(()=>!document.activeElement?.closest('.xterm')));
  await page.getByRole('button',{name:'Seçilen panelin yerleşimi'}).click();
  await page.getByLabel('Konum',{exact:true}).selectOption('center');
  await page.getByRole('button',{name:'Paneli taşı',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.grid-panel .xterm').length===1);
  const saved = await page.evaluate(()=>JSON.parse(localStorage.getItem('agentdeck.terminalGrid.v1')));
  assert.equal(Object.keys(saved.panels).length,2);
  await page.getByRole('button',{name:'Seçilen panelin yerleşimi'}).click();
  await page.getByLabel('Konum',{exact:true}).selectOption('right');
  await page.getByRole('button',{name:'Paneli taşı',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.grid-panel .xterm').length===2);
  await page.getByRole('button',{name:'Seçilen panelin yerleşimi'}).click();
  const before = await page.evaluate(()=>localStorage.getItem('agentdeck.terminalGrid.v1'));
  await page.getByRole('button',{name:'Genişlet',exact:true}).click();
  await page.waitForFunction(before=>localStorage.getItem('agentdeck.terminalGrid.v1')!==before,before);
  await page.getByRole('button',{name:'Bitti',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Seçilen panelin yerleşimi'}).evaluate(el=>el===document.activeElement),true);
  await page.screenshot({path:path.join(output,'grid.png')});
  await page.locator('.session-row').first().click();
  await page.getByRole('button',{name:'Durdur ve komut çalıştır…',exact:true}).click();
  await page.getByLabel('Konuşma UUID’si').fill('latest');
  assert.equal(await page.getByRole('button',{name:'Komuta aktar'}).isDisabled(),true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('dialog[open]').count(),1);
  const id='12345678-1234-1234-1234-123456789abc';
  await page.getByLabel('Konuşma UUID’si').fill(id);
  await page.getByLabel('Program',{exact:true}).selectOption('codex');
  await page.getByLabel('Konuşma UUID’si').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('dialog[open]').count(),1);
  assert.equal(await page.getByLabel('Komut',{exact:true}).inputValue(),'codex resume '+id);
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:600,height:800});
  const trigger=page.getByRole('button',{name:'Projeler ve oturumlar',exact:true});
  await trigger.click();
  await page.locator('#project-drawer[open]').waitFor();
  for(let i=0;i<18;i++) {
   await page.keyboard.press('Tab');
   assert.ok(await page.evaluate(()=>Boolean(document.activeElement.closest('#project-drawer'))));
  }
  await page.keyboard.press('F6');
  assert.ok(await page.evaluate(()=>Boolean(document.activeElement.closest('#project-drawer'))));
  await page.keyboard.press('Escape');
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  await trigger.click();
  await page.getByRole('button',{name:/Terminal grid 2/}).click();
  assert.equal(await page.locator('#project-drawer').evaluate(el=>el.open),false);
  await page.waitForFunction(()=>document.querySelectorAll('.grid-panel .xterm').length===2);
  await nav.getByRole('button',{name:'QA Alpha',exact:true}).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.classList.contains('xterm-helper-textarea'));
  await page.keyboard.press('F6');
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  await page.screenshot({path:path.join(output,'narrow.png')});
  await page.reload();
  await trigger.click();
  await page.getByRole('button',{name:/Terminal grid 2/}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.grid-panel .xterm').length===2);
  for (let remaining=2; remaining>0; remaining--) {
    await page.getByRole('button',{name:'Seçilen panelin yerleşimi'}).click();
    await page.getByRole('button',{name:'Paneli kapat',exact:true}).click();
    await page.waitForFunction(count=>document.querySelectorAll('.grid-panel .xterm').length===count,remaining-1);
  }
  await page.waitForFunction(()=>document.activeElement===document.querySelector('.mobile-navigation button'));
  const preserved=await (await fetch(daemon.url+'/api/state',{headers:{'X-Agentdeck-Token':daemon.token}})).json();
  assert.equal(preserved.sessions.filter(s=>s.lifecycle==='live').length,2);
  await page.evaluate(saved=>localStorage.setItem('agentdeck.terminalGrid.v1',JSON.stringify(saved)),saved);
  await page.evaluate(() => {
    const layout=JSON.parse(localStorage.getItem('agentdeck.terminalGrid.v1'));
    const panel=Object.values(layout.panels)[0];
    for(let i=0;i<9;i++) layout.panels['extra'+i]={...panel,id:'extra'+i,params:{sessionId:'extra'+i}};
    localStorage.setItem('agentdeck.terminalGrid.v1',JSON.stringify(layout));
  });
  await page.reload();
  assert.equal(await page.evaluate(()=>localStorage.getItem('agentdeck.terminalGrid.v1')),null);

  assert.deepEqual(errors,[]);
  if (process.argv.includes('--capacity')) {
    for(let i=2;i<32;i++) sessions.push(await post('/api/sessions',{
      requestId:'capacity-'+i,projectId:project.id,name:'capacity '+i,command:'printf CAPACITY_READY; sleep 300',isolation:'shared'
    }));
    const overflow=await fetch(daemon.url+'/api/sessions',{method:'POST',headers:{'X-Agentdeck-Token':daemon.token,'Content-Type':'application/json'},body:JSON.stringify({requestId:'overflow',projectId:project.id,name:'overflow',command:'sleep 300',isolation:'shared'})});
    assert.equal(overflow.status,409); assert.equal((await overflow.json()).code,'capacity');
    const started=performance.now();
    const state=await (await fetch(daemon.url+'/api/state?previewIds='+sessions.slice(0,24).map(s=>s.id).join(','),{headers:{'X-Agentdeck-Token':daemon.token}})).json();
    assert.equal(state.sessions.filter(s=>s.lifecycle==='live').length,32);
    assert.equal(Object.keys(state.previews).length,24);
    assert.ok(Object.values(state.previews).every(p=>p.state==='ready'),JSON.stringify(Object.values(state.previews).map(p=>p.state)));
    console.log('CAPACITY_PASS',JSON.stringify({live:32,previews:24,stateMs:Math.round(performance.now()-started),rssMiB:Math.round(process.memoryUsage().rss/1024/1024)}));
  }
  console.log('PASS grid roving/activation/F6, tab/split/resize, explicit UUID validation, drawer focus trap/Escape/F6/navigation; no browser errors');

 } finally {await browser?.close();await daemon?.close();fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
