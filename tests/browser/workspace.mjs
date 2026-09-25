import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { startDaemon } from '../../dist/server/daemon.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-browser-'))
const repo = path.join(root, 'project')
fs.mkdirSync(repo)
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()
git('init', '-b', 'main')
fs.writeFileSync(path.join(repo, 'README.md'), '# Browser fixture\n')
git('add', '.')
git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture')
const daemon = await startDaemon({ dataDir: path.join(root, 'data'), port: 0, serveWeb: true })
const executablePath = process.env.CHROME_BIN || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
let browser
try {
  const post = async (route, body) => {
    const response = await fetch(`${daemon.url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentdeck-Token': daemon.token }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const project = await post('projects', { path: repo })
  const sessions = []
  for (let i = 1; i <= 3; i++) sessions.push(await post('sessions', { projectId: project.id, name: `Terminal ${i}`, command: "for i in $(seq 1 200); do echo history-line-$i; done; exec bash --noprofile --norc", isolation: 'shared' }))
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.setDefaultTimeout(10000)
  await page.goto(`${daemon.url}/?token=${daemon.token}`)
  const panel = (id) => `.grid-panel[data-session-id="${id}"]`
  const visible = (id) => page.waitForFunction(sel => Boolean(document.querySelector(sel)), panel(id))
  const activeTab = () => page.evaluate(() => document.querySelector('.dv-active-group [data-session-id]')?.dataset.sessionId ?? null)
  // Oturuma tıklamak onu çalışma alanında sekme olarak açar (ADR 0019).
  await page.locator(`#session-row-${sessions[0].id}`).click()
  await visible(sessions[0].id)
  assert.equal(await page.locator('.clean-topbar').count(), 0)
  await page.waitForSelector('.xterm-rows')
  await page.waitForFunction(() => !document.querySelector('.terminal-status')?.textContent?.includes('Bağlanıyor'))
  // Initial attachment must include scrollback, without using the history button.
  await page.waitForFunction(() => ![...document.querySelectorAll('.terminal-status button')].some(b => b.textContent === 'Geçmiş'))
  const screen = page.locator('.xterm-screen')
  await screen.hover()
  await page.mouse.wheel(0, -4000)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('history-line-1'))
  // Sekme açık kalır; imleç yeniden görünsün diye en alta dönülür.
  await page.mouse.wheel(0, 8000)
  console.log('PASS: a sidebar click opens a tab; history scrolls without the history button')
  await page.getByRole('button', { name: 'Branch yönetimi', exact: true }).click()
  await page.getByLabel('Yeni branch oluştur', { exact: true }).check()
  await page.getByRole('textbox', { name: 'Yeni branch adı' }).fill('feature/browser-check')
  const create = page.getByRole('button', { name: 'Oluştur ve geç', exact: true })
  assert(await create.isVisible()); assert(await create.isEnabled())
  await create.click()
  await page.waitForFunction(() => document.querySelector('.branch-trigger')?.textContent?.includes('feature/browser-check'))
  assert.equal(git('branch', '--show-current'), 'feature/browser-check')
  await page.getByRole('button', { name: 'Branch yönetimini kapat' }).click()
  console.log('PASS: visible branch creation button creates and switches')
  for (const s of sessions.slice(0, 2)) await page.getByRole('button', { name: `${s.name} oturumunu yan yana aç`, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 2)
  // Grid cursors must blink immediately, without focusing either terminal.
  assert.equal(await page.locator('.grid-panel .xterm.focus').count(), 0)
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm-cursor').length === 2)
  for (const off of [false, true, false]) {
    await page.waitForFunction(off => {
      if (document.documentElement.classList.contains('grid-cursor-off') !== off) return false
      const cursors = [...document.querySelectorAll('.grid-panel .xterm-cursor')]
      return cursors.length === 2 && cursors.every(cursor =>
        (getComputedStyle(cursor).backgroundColor === 'rgba(0, 0, 0, 0)') === off)
    }, off, { timeout: 2500 })
  }
  console.log('PASS: focused and unfocused grid cursors blink together')
  await page.locator(`#session-row-${sessions[0].id}`).click()
  assert.equal(await page.locator('.grid-panel .xterm').count(), 2)
  assert.equal(await page.locator('.clean-topbar').count(), 0)
  await page.getByRole('button', { name: 'Yeni çalışma alanı', exact: true }).click()
  await page.getByRole('button', { name: `${sessions[2].name} oturumunu yan yana aç`, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 1)
  await page.locator(`#session-row-${sessions[0].id}`).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 2)
  assert.equal(await page.getByRole('button', { name: 'Alan 1', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.reload()
  await page.locator('.sidebar .home-nav').nth(1).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 2)
  assert.equal(await page.getByRole('button', { name: 'Alan 2', exact: true }).count(), 1)
  console.log('PASS: independent workspaces persist and the sidebar navigates to the containing workspace')
  // + yeni sekmeyi etkin sekmenin projesinde açar; Ctrl+Shift+W sekmeyi kapatır, oturum sürer.
  const countSessions = async () => (await (await fetch(`${daemon.url}/api/state`, { headers: { 'X-Agentdeck-Token': daemon.token } })).json()).sessions.length
  const before = await countSessions()
  const focusedTab = await activeTab()
  await page.getByRole('button', { name: 'Yeni sekme', exact: true }).click()
  await page.waitForFunction(id => { const now = document.querySelector('.dv-active-group [data-session-id]')?.dataset.sessionId; return now && now !== id }, focusedTab)
  assert.equal(await countSessions(), before + 1)
  const opened = await activeTab()
  await page.waitForFunction(() => document.activeElement?.closest('.grid-panel .xterm'))
  await page.keyboard.press('Control+Shift+W')
  await page.waitForFunction(sel => !document.querySelector(sel), panel(opened))
  assert.equal(await countSessions(), before + 1, 'sekmeyi kapatmak oturumu silmez')
  console.log('PASS: the + button opens a new tab and Ctrl+Shift+W closes it without ending the session')
  // Kenar çubuğunda bir oturumu diğerinin üstüne bırakmak ikisini yan yana açar.
  await page.getByRole('button', { name: 'Alan 2', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 1)
  await page.locator(`#session-row-${sessions[1].id}`).dragTo(page.locator(`#session-row-${sessions[2].id}`))
  await page.waitForFunction(ids => ids.every(id => document.querySelector(`.grid-panel[data-session-id="${id}"]`)), [sessions[1].id, sessions[2].id])
  // Orta tık öne getirmeden arka plan sekmesi açar.
  const front = await activeTab()
  await page.locator(`#session-row-${sessions[0].id}`).click({ button: 'middle' })
  await page.waitForFunction(name => [...document.querySelectorAll('.dv-default-tab')].some(el => el.textContent?.includes(name)), sessions[0].name)
  assert.equal(await activeTab(), front)
  await page.getByRole('button', { name: 'Alan 1', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 2)
  console.log('PASS: dropping a session on another opens both side by side; middle click opens a background tab')
  for (const width of [900, 1500, 1100, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    // Son satır kırpılmamalı: ekran, kutunun iç boşluğu düşülmüş alanında kalır.
    await page.waitForFunction(() => [...document.querySelectorAll('.term-host')].every(host => {
      const screen = host.querySelector('.xterm-screen')?.getBoundingClientRect()
      const box = host.getBoundingClientRect()
      const style = getComputedStyle(host)
      const bottom = box.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth)
      return screen && screen.right <= box.right && screen.bottom <= bottom + 0.5 && screen.height > box.height - 40
    }))
  }
  const top = await page.locator('.grid-stage').boundingBox()
  assert(top.y < 110, `Grid chrome too tall: ${top.y}`)
  await page.locator('.grid-panel .xterm-screen').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Böl / panel yerleşimi…' }).click()
  await page.getByRole('button', { name: 'Yeni terminal · alta', exact: true }).click()
  await page.getByLabel('Terminal adı').fill('Split terminal')
  await page.getByRole('radio', { name: 'Kabuk', exact: true }).check()
  for (const label of ['Grok', 'OpenCode', 'Antigravity']) assert(await page.getByRole('radio', { name: label, exact: true }).count())
  await page.getByRole('button', { name: 'Oturumu başlat', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 3)
  console.log('PASS: compact grid fits after resize; context menu creates split terminal')
  await page.getByRole('button', { name: 'Ayarlar' }).click()
  await page.getByRole('radio', { name: 'Forest', exact: true }).check()
  await page.getByRole('button', { name: 'Bitti', exact: true }).click()
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'forest')
  await page.locator('.project-head').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Proje rengi…' }).click()
  await page.getByLabel('Vurgu rengi').fill('#ff8800')
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click()
  assert.equal(await page.locator('.grid-panel').first().evaluate(el => el.style.getPropertyValue('--project-color')), '#ff8800')
  await page.locator('.grid-panel .xterm-screen').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Terminal rengi…' }).click()
  await page.getByLabel('Vurgu rengi').fill('#44bbff')
  await page.getByRole('button', { name: 'Kaydet', exact: true }).click()
  assert.equal(await page.locator('.grid-panel').first().evaluate(el => el.style.getPropertyValue('--project-color')), '#44bbff')
  await page.screenshot({ path: '/tmp/agentdeck-workspace.png' })
  // A real child process named claude exercises process detection and live tab updates.
  const agentExecutable = path.join(root, 'claude')
  fs.copyFileSync('/bin/sleep', agentExecutable)
  fs.chmodSync(agentExecutable, 0o755)
  const automatic = await post('sessions', { projectId: project.id, name: '', command: null, isolation: 'shared' })
  await page.reload()
  await page.getByRole('button', { name: `${automatic.name} oturumunu yan yana aç`, exact: true }).click()
  const pane = page.locator(`.grid-panel[data-session-id="${automatic.id}"]`)
  await page.waitForFunction(id => document.querySelector(`[data-session-id="${id}"] .terminal-status`)?.textContent?.includes('Kontrol sizde'), automatic.id)
  await pane.locator('.xterm-screen').click()
  await page.keyboard.type(`${agentExecutable} 30`)
  await page.keyboard.press('Enter')
  const liveName = `Claude Code ${automatic.id.slice(0, 6)}`
  await page.waitForFunction(name => [...document.querySelectorAll('.dv-default-tab')].some(el => el.textContent?.includes(name)), liveName)
  assert((await page.locator(`#session-row-${automatic.id}`).textContent()).includes(liveName))
  await page.keyboard.press('Control+c')
  await page.waitForFunction(name => [...document.querySelectorAll('.dv-default-tab')].some(el => el.textContent?.includes(name)), automatic.name)
  assert((await page.locator(`#session-row-${automatic.id}`).textContent()).includes(automatic.name))
  console.log('PASS: manual agent launch updates automatic sidebar/tab titles and exit restores shell title')
  await page.addInitScript(() => {
    window.testNotices = []
    window.agentdeckDesktop = {
      notify: async notice => { window.testNotices.push(notice) },
      selectProjectFolder: async () => null,
    }
  })
  await page.reload()
  await page.getByRole('button', { name: 'Ayarlar' }).click()
  await page.getByLabel('Bildirimler', { exact: false }).check()
  await page.getByRole('button', { name: 'Test bildirimi gönder' }).click()
  await page.waitForFunction(() => window.testNotices.length === 1)
  await page.getByRole('button', { name: 'Bitti', exact: true }).click()
  const attention = await post('sessions', {
    projectId: project.id,
    name: 'Onay bekleyen terminal',
    command: "printf 'Proceed? [y/N]\n'; sleep 300",
    isolation: 'shared',
  })
  // Pencere öndeyken bildirim köşe kartıdır; masaüstü bildirimi gitmez.
  await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')) })
  await page.waitForFunction(() => [...document.querySelectorAll('.notification-toast')].some(el => el.textContent?.includes('Onayınızı bekliyor')))
  assert.equal(await page.locator('.notification-toast').filter({ hasText: 'Onayınızı bekliyor' }).count(), 1)
  assert.equal(await page.evaluate(id => window.testNotices.filter(n => n.sessionId === id).length, attention.id), 0)
  // Bildirimli oturumu açmak onu okunmuş sayar; kayıt listeden kalkar.
  await page.locator('.notification-toast-open').filter({ hasText: 'Onayınızı bekliyor' }).click()
  await visible(attention.id)
  await page.waitForFunction(() => document.querySelectorAll('.notification-toast').length === 0)
  await page.keyboard.press('Escape')
  // Arka plandaki pencerede masaüstü bildirimi gider ve oturum başına bir kez gelir.
  await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')) })
  await post(`sessions/${automatic.id}/stop`, { expectedRunId: automatic.runId })
  await page.waitForFunction(id => window.testNotices.some(n => n.sessionId === id), automatic.id)
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.equal(await page.evaluate(id => window.testNotices.filter(n => n.sessionId === id).length, automatic.id), 1)
  // Hidden windows must keep polling when desktop notifications are enabled.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await post(`sessions/${sessions[0].id}/stop`, { expectedRunId: sessions[0].runId })
  await page.waitForFunction(id => window.testNotices.some(n => n.sessionId === id), sessions[0].id)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.hasFocus = () => true
    document.dispatchEvent(new Event('visibilitychange'))
  })
  console.log('PASS: foreground notices toast once and clear when opened; background and hidden windows get one desktop notice')
  // Deletions confirm in a modal where they were asked; the scan never navigates to the session.
  const spare = path.join(root, 'spare')
  fs.mkdirSync(spare)
  const spareProject = await post('projects', { path: spare })
  await page.reload()
  await page.locator('.sidebar .home-nav').first().click()
  const spareHead = page.locator('.project-head', { hasText: spareProject.name })
  await spareHead.hover()
  await spareHead.getByTitle('Projeyi kaldır').click()
  const confirm = page.getByRole('alertdialog')
  await confirm.waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Vazgeç')
  await confirm.getByRole('button', { name: 'Vazgeç', exact: true }).click()
  assert.equal(await spareHead.count(), 1)
  await spareHead.hover()
  await spareHead.getByTitle('Projeyi kaldır').click()
  await confirm.getByRole('button', { name: 'Kaydı kaldır', exact: true }).click()
  await page.waitForFunction(name => ![...document.querySelectorAll('.project-head')].some(el => el.textContent?.includes(name)), spareProject.name)
  const card = page.locator(`#session-card-${sessions[0].id}`)
  await card.getByRole('button', { name: `${sessions[0].name} işlemleri`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Silme seçenekleri…' }).click()
  await confirm.waitFor()
  assert.equal(await page.locator('.clean-topbar').count(), 0)
  await confirm.getByRole('button', { name: 'Kaydı kaldır', exact: true }).click()
  await card.waitFor({ state: 'detached' })
  console.log('PASS: project removal and session deletion confirm in a modal without leaving the scan')
  // Mouse-tracking TUIs (Grok) must still receive SGR clicks after the screen is rebuilt from a snapshot.
  const mouseApp = await post('sessions', { projectId: project.id, name: 'Fare TUI', command: "printf '\\033[?1003h\\033[?1006hFARE-HAZIR\\n'; exec cat", isolation: 'shared' })
  await new Promise(resolve => setTimeout(resolve, 500))
  await page.reload()
  await page.locator(`#session-row-${mouseApp.id}`).click()
  const mouse = panel(mouseApp.id)
  await page.waitForFunction(sel => document.querySelector(`${sel} .terminal-status`)?.textContent?.includes('Kontrol sizde'), mouse)
  await page.waitForFunction(sel => document.querySelector(`${sel} .xterm-rows`)?.textContent?.includes('FARE-HAZIR'), mouse)
  const mouseBox = await page.locator(`${mouse} .xterm-screen`).boundingBox()
  await page.mouse.click(mouseBox.x + 120, mouseBox.y + 80)
  // The tty echoes the report; an X10 report would be dropped by the client and never echo.
  await page.waitForFunction(sel => /\^\[\[<0;\d+;\d+M/.test(document.querySelector(`${sel} .xterm-rows`)?.textContent ?? ''), mouse)
  console.log('PASS: mouse-tracking TUI receives SGR clicks after snapshot replay')
  // Klavyeyle gezinme: kısayollar terminal odaktayken çalışır ve PTY'ye hiç ulaşmaz.
  const shortcut = await page.locator(`#session-row-${attention.id}`).getAttribute('aria-keyshortcuts')
  assert.match(shortcut, /^Alt\+[1-9]$/)
  await page.locator(`${mouse} .xterm-screen`).click()
  await page.waitForFunction(sel => document.activeElement?.closest(`${sel} .xterm`), mouse)
  await page.keyboard.press(`Alt+Digit${shortcut.slice(4)}`)
  await visible(attention.id)
  await page.keyboard.press('Control+Shift+P')
  await page.getByRole('combobox', { name: 'Oturum, ajan veya komut ara' }).fill('Fare TUI')
  await page.keyboard.press('Enter')
  await visible(mouseApp.id)
  await page.waitForFunction(sel => document.querySelector(`${sel} .xterm-rows`)?.textContent?.includes('FARE-HAZIR'), mouse)
  // cat her girdiyi yankılar; Alt+rakam (ESC + rakam) PTY'ye gitseydi ekranda ^[<rakam> görünürdü.
  assert(!(await page.locator(`${mouse} .xterm-rows`).textContent()).includes(`^[${shortcut.slice(4)}`))
  console.log('PASS: Alt+N and Ctrl+Shift+P switch sessions from a focused terminal without reaching the PTY')
  const rowsBefore = await page.locator('.session-row').count()
  // Ctrl+K kabukta satır silmedir: terminal odaktayken paleti açmaz, terminale gider.
  await page.keyboard.press('Control+k')
  assert.equal(await page.locator('dialog.palette-modal').count(), 0)
  await page.keyboard.press('Control+Shift+P')
  await page.getByRole('option', { name: /Kabuk.*içinde yeni oturum başlat/ }).first().click()
  await page.waitForFunction(count => document.querySelectorAll('.session-row').length === count + 1, rowsBefore)
  await page.waitForFunction(() => document.activeElement?.closest('.grid-panel .xterm'))
  // Ctrl+PgDn çalışma alanında sekmeler arasında dolaşır ve öne gelen terminale odak verir.
  const shell = await activeTab()
  await page.keyboard.press('Control+PageDown')
  await page.waitForFunction(id => { const now = document.querySelector('.dv-active-group [data-session-id]')?.dataset.sessionId; return now && now !== id }, shell)
  await page.keyboard.press('Control+PageUp')
  await page.waitForFunction(id => document.querySelector('.dv-active-group [data-session-id]')?.dataset.sessionId === id, shell)
  console.log('PASS: palette quick-starts a shell tab and Ctrl+PgUp/PgDn cycle tabs')
  // Ctrl basılı sürükleme özgün oturumu taşımaz; aynı komutla yeni oturum açıp grid'e koyar.
  await page.locator('.sidebar .home-nav').nth(1).click()
  await page.locator('.grid-stage').waitFor()
  const panelsBefore = await page.locator('.grid-panel').count()
  const sessionsBefore = (await (await fetch(`${daemon.url}/api/state`, { headers: { 'X-Agentdeck-Token': daemon.token } })).json()).sessions.length
  await page.keyboard.down('Control')
  await page.locator(`#session-row-${mouseApp.id}`).dragTo(page.locator('.grid-panel').first())
  await page.keyboard.up('Control')
  await page.waitForFunction(count => document.querySelectorAll('.grid-panel').length === count + 1, panelsBefore)
  const after = (await (await fetch(`${daemon.url}/api/state`, { headers: { 'X-Agentdeck-Token': daemon.token } })).json()).sessions
  assert.equal(after.length, sessionsBefore + 1)
  const copy = after.find(s => !sessions.concat([automatic, attention, mouseApp]).some(o => o.id === s.id) && s.command === mouseApp.command)
  assert(copy, 'kopya aynı komutla açılmalı')
  console.log('PASS: Ctrl+drag from the sidebar opens a copy of the same program in the workspace')
  await page.keyboard.press('Control+Shift+B')
  await page.waitForFunction(() => document.querySelector('.sidebar')?.classList.contains('collapsed') && document.querySelector('.sidebar').getBoundingClientRect().width < 80)
  await page.locator(`#session-row-${mouseApp.id}`).click()
  await page.waitForFunction(id => document.querySelector(`#session-row-${id}.active`) || document.querySelector(`.grid-panel[data-session-id="${id}"]`), mouseApp.id)
  await page.getByRole('button', { name: 'Kenar çubuğunu genişlet' }).click()
  await page.waitForFunction(() => !document.querySelector('.sidebar')?.classList.contains('collapsed'))
  console.log('PASS: sidebar collapses to an icon rail and stays navigable')
  // Sekme menüsü, taşıma, orta tık ve boş şeride çift tık.
  const tabs = []
  for (let i = 1; i <= 3; i++) tabs.push(await post('sessions', { projectId: project.id, name: `Sekme ${i}`, command: 'exec bash --noprofile --norc', isolation: 'shared' }))
  await page.locator('.sidebar .home-nav').nth(1).click()
  await page.getByRole('button', { name: 'Yeni çalışma alanı', exact: true }).click()
  for (const t of tabs) await page.locator(`#session-row-${t.id}`).click()
  const tabNames = () => page.evaluate(() => [...document.querySelectorAll('.dv-default-tab-content')].map(t => t.textContent).join(','))
  await page.waitForFunction(() => document.querySelectorAll('.dv-default-tab').length === 3)
  assert.equal(await tabNames(), 'Sekme 1,Sekme 2,Sekme 3')
  await page.locator(`${panel(tabs[2].id)} .xterm-screen`).click()
  await page.keyboard.press('Control+Shift+PageUp')
  await page.waitForFunction(() => [...document.querySelectorAll('.dv-default-tab-content')].map(t => t.textContent).join(',') === 'Sekme 1,Sekme 3,Sekme 2')
  await page.locator('.dv-default-tab', { hasText: 'Sekme 1' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Sağdakileri kapat' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.dv-default-tab').length === 1)
  await page.locator('.dv-default-tab', { hasText: 'Sekme 1' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Kapatılan sekmeyi geri aç' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.dv-default-tab').length === 2)
  await page.locator('.dv-default-tab', { hasText: 'Sekme 1' }).click({ button: 'middle' })
  await page.waitForFunction(() => document.querySelectorAll('.dv-default-tab').length === 1)
  const sessionsNow = await countSessions()
  await page.locator('.dv-void-container').first().dblclick()
  await page.waitForFunction(() => document.querySelectorAll('.dv-default-tab').length === 2)
  assert.equal(await countSessions(), sessionsNow + 1, 'kapatılan sekmeler oturum silmez; çift tık yeni oturum açar')
  console.log('PASS: tab menu closes tabs to the right and reopens one; Ctrl+Shift+PgUp moves a tab; middle click closes; double click on the strip opens a new tab')
  assert.deepEqual(errors, [])
  console.log('PASS: themes, project color inheritance, terminal override; no browser errors')
} finally {
  await browser?.close()
  await daemon.close()
  fs.rmSync(root, { recursive: true, force: true })
}
