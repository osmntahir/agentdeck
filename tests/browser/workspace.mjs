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
  await page.locator(`#session-row-${sessions[0].id}`).click()
  await page.waitForSelector('.xterm-rows')
  await page.waitForFunction(() => !document.querySelector('.terminal-status')?.textContent?.includes('Bağlanıyor'))
  // Initial attachment must include scrollback, without using the history button.
  await page.waitForFunction(() => ![...document.querySelectorAll('.terminal-status button')].some(b => b.textContent === 'Geçmiş'))
  const screen = page.locator('.xterm-screen')
  await screen.hover()
  await page.mouse.wheel(0, -4000)
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('history-line-1'))
  console.log('PASS: detail history scroll without history button')
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
  for (const s of sessions.slice(0, 2)) await page.getByRole('button', { name: `${s.name} oturumunu terminal grid'e ekle`, exact: true }).click()
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
  await page.getByRole('button', { name: 'Yeni grid', exact: true }).click()
  await page.getByRole('button', { name: `${sessions[2].name} oturumunu terminal grid'e ekle`, exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 1)
  await page.locator(`#session-row-${sessions[0].id}`).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 2)
  assert.equal(await page.getByRole('button', { name: 'Grid 1', exact: true }).getAttribute('aria-pressed'), 'true')
  await page.reload()
  await page.getByRole('button', { name: /Terminal grid/ }).click()
  await page.waitForFunction(() => document.querySelectorAll('.grid-panel .xterm').length === 2)
  assert.equal(await page.getByRole('button', { name: 'Grid 2', exact: true }).count(), 1)
  console.log('PASS: independent grids persist and sidebar navigates to containing grid')
  for (const width of [900, 1500, 1100, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    await page.waitForFunction(() => [...document.querySelectorAll('.term-host')].every(host => {
      const screen = host.querySelector('.xterm-screen')?.getBoundingClientRect()
      const box = host.getBoundingClientRect()
      return screen && screen.width <= box.width && screen.height <= box.height && screen.height > box.height - 40
    }))
  }
  const top = await page.locator('.grid-stage').boundingBox()
  assert(top.y < 110, `Grid chrome too tall: ${top.y}`)
  await page.locator('.grid-panel .xterm-screen').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Böl / panel yerleşimi…' }).click()
  await page.getByRole('button', { name: 'Yeni terminal · alta', exact: true }).click()
  await page.getByLabel('Görev adı').fill('Split terminal')
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
  await page.getByRole('button', { name: `${automatic.name} oturumunu terminal grid'e ekle`, exact: true }).click()
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
  await page.waitForFunction(id => window.testNotices.some(n => n.sessionId === id), attention.id)
  await page.waitForFunction(() => [...document.querySelectorAll('.notification-toast')].some(el => el.textContent?.includes('müdahale gerekli')))
  assert.equal(await page.locator('.notification-toast').filter({ hasText: 'müdahale gerekli' }).count(), 1)
  await post(`sessions/${automatic.id}/stop`, { expectedRunId: automatic.runId })
  await page.waitForFunction(id => window.testNotices.some(n => n.sessionId === id), automatic.id)
  assert.equal(await page.evaluate(id => window.testNotices.filter(n => n.sessionId === id).length, automatic.id), 1)
  // Hidden windows must keep polling when desktop notifications are enabled.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await post(`sessions/${sessions[0].id}/stop`, { expectedRunId: sessions[0].runId })
  await page.waitForFunction(id => window.testNotices.some(n => n.sessionId === id), sessions[0].id)
  console.log('PASS: native notification bridge receives test and terminal-exit notifications, including hidden windows')
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
  await page.waitForFunction(() => document.querySelector('.terminals .terminal-status span')?.textContent === 'Kontrol sizde')
  await page.waitForFunction(() => document.querySelector('.terminals .xterm-rows')?.textContent?.includes('FARE-HAZIR'))
  const mouseBox = await page.locator('.terminals .xterm-screen').boundingBox()
  await page.mouse.click(mouseBox.x + 120, mouseBox.y + 80)
  // The tty echoes the report; an X10 report would be dropped by the client and never echo.
  await page.waitForFunction(() => /\^\[\[<0;\d+;\d+M/.test(document.querySelector('.terminals .xterm-rows')?.textContent ?? ''))
  console.log('PASS: mouse-tracking TUI receives SGR clicks after snapshot replay')
  // Klavyeyle gezinme: kısayollar terminal odaktayken çalışır ve PTY'ye hiç ulaşmaz.
  const titleIs = (name) => page.waitForFunction(name => document.querySelector('.clean-topbar .title')?.textContent === name, name)
  const shortcut = await page.locator(`#session-row-${attention.id}`).getAttribute('aria-keyshortcuts')
  assert.match(shortcut, /^Alt\+[1-9]$/)
  await page.locator('.terminals .xterm-screen').click()
  await page.waitForFunction(() => document.activeElement?.closest('.terminals .xterm'))
  await page.keyboard.press(`Alt+Digit${shortcut.slice(4)}`)
  await titleIs(attention.name)
  await page.keyboard.press('Control+Shift+P')
  await page.getByRole('combobox', { name: 'Oturum, ajan veya komut ara' }).fill('Fare TUI')
  await page.keyboard.press('Enter')
  await titleIs('Fare TUI')
  await page.waitForFunction(() => document.querySelector('.terminals .xterm-rows')?.textContent?.includes('FARE-HAZIR'))
  // cat her girdiyi yankılar; Alt+rakam (ESC + rakam) PTY'ye gitseydi ekranda ^[<rakam> görünürdü.
  assert(!(await page.locator('.terminals .xterm-rows').textContent()).includes(`^[${shortcut.slice(4)}`))
  console.log('PASS: Alt+N and Ctrl+Shift+P switch sessions from a focused terminal without reaching the PTY')
  const rowsBefore = await page.locator('.session-row').count()
  // Ctrl+K kabukta satır silmedir: terminal odaktayken paleti açmaz, terminale gider.
  await page.keyboard.press('Control+k')
  assert.equal(await page.locator('dialog.palette-modal').count(), 0)
  await page.keyboard.press('Control+Shift+P')
  await page.getByRole('option', { name: /Kabuk.*içinde yeni oturum başlat/ }).first().click()
  await page.waitForFunction(count => document.querySelectorAll('.session-row').length === count + 1, rowsBefore)
  await page.waitForFunction(() => document.activeElement?.closest('.terminals .xterm'))
  const order = await page.evaluate(() => [...document.querySelectorAll('.session-row')].map(row => row.id.replace('session-row-', '')))
  const current = await page.evaluate(() => document.querySelector('.session-row.active')?.id.replace('session-row-', ''))
  const next = order[(order.indexOf(current) + 1) % order.length]
  await page.keyboard.press('Control+PageDown')
  await page.waitForFunction(id => document.querySelector(`#session-row-${id}.active`) || document.querySelector(`.grid-panel[data-session-id="${id}"]`), next)
  console.log('PASS: palette quick-starts a shell and Ctrl+PgDn cycles to the next session')
  assert.deepEqual(errors, [])
  console.log('PASS: themes, project color inheritance, terminal override; no browser errors')
} finally {
  await browser?.close()
  await daemon.close()
  fs.rmSync(root, { recursive: true, force: true })
}
