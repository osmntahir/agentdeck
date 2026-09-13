/** Verifies browser startup recovery with shell fixtures, never real agent authentication. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), assert=require('node:assert/strict');
const {startDaemon}=require('../../dist/server/daemon.js');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agentdeck-recovery-')); const dataDir=path.join(root,'data'); fs.mkdirSync(dataDir);
 const base={projectId:'p', isolation:'shared', cwd:root, branch:null,baseCommit:null,worktrees:[],exitCode:null,exitSignal:null,createdAt:1,endedAt:null,archivedAt:null,lastLaunch:null,command:null};
 const oldRun='12345678901234567890123456789012';
 fs.writeFileSync(path.join(dataDir,'state.json'),JSON.stringify({schemaVersion:2,projects:[{id:'p',name:'Recovery',path:root,kind:'folder',createdAt:1}],sessions:[
  {...base,id:'recover',name:'Yarım kalan terminal',lifecycle:'live',runId:oldRun},
  {...base,id:'ended',name:'Bilerek biten',lifecycle:'exited',runId:null,exitCode:0,endedAt:2},
  {...base,id:'custom',name:'Genel program',lifecycle:'live',command:'touch unexpected',runId:'22345678901234567890123456789012'},
 ]}));
 let daemon,browser;
 try {
  daemon=await startDaemon({dataDir,port:0,serveWeb:true});
  const state=async()=> (await fetch(daemon.url+'/api/state',{headers:{'X-Agentdeck-Token':daemon.token}})).json();
  browser=await chromium.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('agentdeck.preferences.v1',JSON.stringify({restore:false})));
  await page.goto(daemon.url+'/?token='+daemon.token);
  await page.locator('.session-card').first().waitFor();
  assert.equal((await state()).sessions.find(s=>s.id==='recover').lifecycle,'orphaned');
  await page.getByRole('button',{name:'⚙ Ayarlar',exact:true}).click();
  await page.getByLabel('Yarım kalan oturumları geri aç',{exact:false}).check();
  await page.getByRole('button',{name:'Bitti',exact:true}).click();
  await page.locator('.session-row').waitFor();
  const restored=await state(); const session=restored.sessions.find(s=>s.id==='recover');
  assert.equal(session.lifecycle,'live'); assert.notEqual(session.runId,oldRun); assert.equal(session.cwd,root);
  assert.equal(restored.sessions.length,3); assert.equal(restored.sessions.find(s=>s.id==='custom').lifecycle,'orphaned'); assert.equal(restored.sessions.find(s=>s.id==='ended').lifecycle,'exited'); assert.equal(fs.existsSync(path.join(root,'unexpected')),false);
  await page.reload(); await page.locator('.session-row').waitFor();
  assert.equal((await state()).sessions.find(s=>s.id==='recover').runId,session.runId);
  assert.equal(await page.locator('.session-row').count(),1);
  console.log('PASS recovery setting, same Session/cwd, no duplicate Run on reload, no automatic exited/custom command execution');
 } finally {await browser?.close();await daemon?.close();fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
