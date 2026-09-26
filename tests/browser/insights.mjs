import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { startDaemon } from '../../dist/server/daemon.js'
import { HOOK_COMMAND } from '../../dist/server/claudeHooks.js'

// Oturum portları, kullanım göstergesi ve konuşma araması (ADR 0023).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-insights-'))
const project = path.join(root, 'project')
const claudeDir = path.join(root, 'claude')
const shots = process.env.SHOTS_DIR
fs.mkdirSync(project)
const fake = path.join(root, 'fake-claude')
fs.writeFileSync(fake, '#!/bin/sh\nprintf "[]"\n', { mode: 0o755 })
const transcripts = path.join(claudeDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
fs.mkdirSync(transcripts, { recursive: true })

const line = (value) => JSON.stringify(value)
const conversation = '66666666-6666-4666-8666-666666666666'
const transcript = path.join(transcripts, `${conversation}.jsonl`)
const usage = { input_tokens: 12, output_tokens: 4200, cache_read_input_tokens: 184_000, cache_creation_input_tokens: 9_000 }
fs.writeFileSync(transcript, [
  line({ type: 'user', cwd: project, timestamp: '2026-09-26T09:00:00Z', message: { content: 'Ödeme sayfasındaki Stripe webhook imzası neden tutmuyor?' } }),
  line({ type: 'assistant', cwd: project, timestamp: '2026-09-26T09:01:00Z', message: { model: 'claude-opus-5-5', id: 'msg_1', content: [{ type: 'text', text: 'Webhook gövdesi JSON olarak çözüldükten sonra imzalanıyor; ham gövdeyi kullanmak gerekiyor.' }], usage } }),
  '',
].join('\n'))
fs.writeFileSync(path.join(transcripts, '77777777-7777-4777-8777-777777777777.jsonl'), [
  line({ type: 'user', cwd: project, timestamp: '2026-09-25T12:00:00Z', message: { content: 'README dosyasına kurulum adımlarını ekle' } }),
  '',
].join('\n'))
const hook = path.join(root, 'hook.sh')
fs.writeFileSync(hook, HOOK_COMMAND)
const event = path.join(root, 'event.json')
fs.writeFileSync(event, JSON.stringify({ session_id: conversation, source: 'startup', hook_event_name: 'SessionStart', transcript_path: transcript }))

const daemon = await startDaemon({ dataDir: path.join(root, 'data'), port: 0, serveWeb: true, claudeAgents: { command: fake, claudeDir } })
const executablePath = process.env.CHROME_BIN || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
let browser
try {
  const post = async (route, body) => {
    const response = await fetch(`${daemon.url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentdeck-Token': daemon.token }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const created = await post('projects', { path: project })
  const work = await post('works', { projectId: created.id, name: 'Ödeme' })
  const server = `sh '${hook}' < '${event}'; exec "${process.execPath}" -e "require('net').createServer().listen(Number(process.env.PORT),'127.0.0.1');setInterval(()=>{},1e6)"`
  const session = await post('sessions', { projectId: created.id, name: 'Stripe düzeltmesi', command: server, isolation: 'shared', workId: work.id })
  assert.ok(session.port >= 4800 && session.port <= 5799, String(session.port))

  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-3d-apis'] })
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(12000)
  await page.goto(`${daemon.url}/?token=${daemon.token}`)

  // Kart: API karşılığı ve dinlenen port.
  const card = page.locator(`#session-card-${session.id}`)
  await card.locator('.port-link').waitFor()
  assert.equal((await card.locator('.port-link').textContent()).trim(), `:${session.port}`)
  assert.equal(await card.locator('.port-link').getAttribute('href'), `http://localhost:${session.port}`)
  assert.match(await card.locator('.usage-amount').textContent(), /^\$\d+,\d\d$/)
  assert.match(await page.locator('.work-block-head .usage-amount').textContent(), /^\$/)
  if (shots) await page.screenshot({ path: path.join(shots, 'insights-cards.png') })

  // Sekme başlığı: port bağlantısı ve bağlam halkası.
  await page.locator(`#session-row-${session.id}`).click()
  const header = page.locator('.dv-groupview .grid-group-actions').first()
  await header.locator('.port-link').waitFor()
  const meter = header.locator('.context-meter')
  await meter.waitFor()
  assert.equal(await meter.locator('.context-tokens').textContent(), '197k')
  assert.equal(await meter.getAttribute('data-tone'), 'low')
  assert.match(await meter.getAttribute('title'), /Bağlam: 197k \/ 1M token \(%20\) · Opus 5\.5/)
  if (shots) await page.screenshot({ path: path.join(shots, 'insights-header.png') })

  // Ctrl+Shift+F: konuşma araması Türkçe işaretlerden bağımsız bulur ve eşleşmeyi işaretler.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+Shift+F')
  await page.locator('.palette-scope').waitFor()
  await page.keyboard.type('odeme imza')
  const hit = page.locator('.palette-item:has(.palette-conversation)').first()
  await hit.waitFor()
  assert.equal(await page.locator('.palette-item:has(.palette-conversation)').count(), 1)
  assert.deepEqual(await hit.locator('mark').allTextContents(), ['Ödeme', 'imza'])
  assert.equal((await hit.locator('.palette-tag').textContent()).trim(), 'Açık')
  if (shots) await page.screenshot({ path: path.join(shots, 'insights-search.png') })

  // Ajan yanıtındaki eşleşme rolüyle gösterilir.
  const input = page.locator('.palette-search input')
  await input.fill('ham govde')
  await page.locator('.palette-role[data-role="assistant"]').waitFor()
  assert.deepEqual(await page.locator('.palette-item:has(.palette-conversation) mark').allTextContents(), ['gövde', 'ham', 'gövde'])
  if (shots) await page.screenshot({ path: path.join(shots, 'insights-search-assistant.png') })

  // Boş sorguda ⌫ genel palete döner; genel palette 3 harften sonra konuşmalar da gelir.
  await input.fill('')
  await page.keyboard.press('Backspace')
  await page.locator('.palette-scope').waitFor({ state: 'detached' })
  await page.keyboard.type('kurulum')
  await page.locator('.palette-section', { hasText: 'Konuşmalar' }).waitFor()
  if (shots) await page.screenshot({ path: path.join(shots, 'insights-palette-all.png') })
  await page.keyboard.press('Escape')

  assert.deepEqual(errors, [])
  console.log('insights: ok')
} finally {
  await browser?.close()
  await daemon.close()
  fs.rmSync(root, { recursive: true, force: true })
}
