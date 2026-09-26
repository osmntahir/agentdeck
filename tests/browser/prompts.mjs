import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { startDaemon } from '../../dist/server/daemon.js'
import { HOOK_COMMAND } from '../../dist/server/claudeHooks.js'

// İstem sırası, tekrar önerisi ve hazır istem (ADR 0024).
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-prompts-'))
const project = path.join(root, 'project')
const claudeDir = path.join(root, 'claude')
const shots = process.env.SHOTS_DIR
fs.mkdirSync(project)
const fakeAgents = path.join(root, 'fake-agents')
fs.writeFileSync(fakeAgents, '#!/bin/sh\nprintf "[]"\n', { mode: 0o755 })
const transcripts = path.join(claudeDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
fs.mkdirSync(transcripts, { recursive: true })
const flow = ['Testleri çalıştır ve kırılanları düzelt', 'Değişiklikleri anlamlı bir mesajla commit et']
const history = (id, first) => fs.writeFileSync(path.join(transcripts, `${id}.jsonl`), [first, ...flow].map((content, i) =>
  JSON.stringify({ type: 'user', cwd: project, timestamp: `2026-09-2${i}T10:00:00Z`, message: { content } })).join('\n') + '\n')
history('a1111111-1111-4111-8111-111111111111', 'Ödeme sayfasını yap')
history('b2222222-2222-4222-8222-222222222222', 'README dosyasını güncelle')

// Claude'u taklit eden program: kancaları çalıştırır, aldığı istemleri dosyaya yazar.
const fake = path.join(root, 'claude.js')
fs.writeFileSync(fake, `
const { execFileSync } = require('child_process')
const fs = require('fs')
const [hook, received] = process.argv.slice(2)
const fire = (name) => execFileSync('sh', [hook], { input: JSON.stringify({ session_id: 'c3333333-3333-4333-8333-333333333333', hook_event_name: name, source: 'startup' }) })
fire('SessionStart')
process.stdout.write('Claude hazır\\r\\n')
let buffer = ''
process.stdin.on('data', (data) => {
  buffer += data.toString()
  let end
  while ((end = buffer.search(/[\\r\\n]/)) >= 0) {
    const line = buffer.slice(0, end).replace(/\\x1b\\[20[01]~/g, '')
    buffer = buffer.slice(end + 1)
    if (!line) continue
    fire('UserPromptSubmit')
    fs.appendFileSync(received, line + '\\n')
    process.stdout.write('> ' + line + '\\r\\n')
    setTimeout(() => fire('Stop'), 4000)
  }
})
`)
const hook = path.join(root, 'hook.sh')
fs.writeFileSync(hook, HOOK_COMMAND)
const received = path.join(root, 'received.txt')
const lines = () => (fs.existsSync(received) ? fs.readFileSync(received, 'utf8').trim().split('\n').filter(Boolean) : [])
const until = async (check, ms = 15000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (check()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('zaman aşımı')
}

const daemon = await startDaemon({ dataDir: path.join(root, 'data'), port: 0, serveWeb: true, claudeAgents: { command: fakeAgents, claudeDir } })
const executablePath = process.env.CHROME_BIN || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined)
let browser
try {
  const post = async (route, body) => {
    const response = await fetch(`${daemon.url}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentdeck-Token': daemon.token }, body: JSON.stringify({ requestId: crypto.randomUUID(), ...body }) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const created = await post('projects', { path: project })
  const session = await post('sessions', { projectId: created.id, name: 'Ödeme', command: `exec "${process.execPath}" '${fake}' '${hook}' '${received}'`, isolation: 'shared' })

  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-3d-apis'] })
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.setDefaultTimeout(15000)
  await page.goto(`${daemon.url}/?token=${daemon.token}`)
  await page.locator(`#session-row-${session.id}`).click()

  // Claude bekliyorken yazılan istem hemen gider; tur sürerken eklenenler sırada durur.
  const trigger = page.locator('.dv-groupview .queue-trigger').first()
  await trigger.click()
  const dialog = page.locator('.queue-dialog')
  await dialog.locator('.queue-status[data-tone="waiting"]').waitFor()
  await dialog.locator('textarea').fill('Ödeme formuna doğrulama ekle')
  await dialog.locator('textarea').press('Enter')
  await until(() => lines().length === 1)
  await dialog.locator('.queue-status[data-tone="working"]').waitFor()
  await dialog.locator('textarea').fill('Hata mesajlarını Türkçeleştir')
  await dialog.locator('textarea').press('Enter')
  await dialog.locator('textarea').fill('Birim testlerini yaz')
  await dialog.locator('textarea').press('Enter')
  await dialog.locator('.queue-item').nth(1).waitFor()
  assert.deepEqual(await dialog.locator('.queue-text p').allTextContents(), ['Hata mesajlarını Türkçeleştir', 'Birim testlerini yaz'])
  if (shots) await page.screenshot({ path: path.join(shots, 'prompts-queue.png') })
  await until(() => lines().length === 3, 30000)
  assert.deepEqual(lines(), ['Ödeme formuna doğrulama ekle', 'Hata mesajlarını Türkçeleştir', 'Birim testlerini yaz'])
  await dialog.getByRole('button', { name: 'Kapat' }).click()
  // Kuyruk boşalınca başlıktaki sayı kalkar.
  await page.locator('.dv-groupview .queue-count').waitFor({ state: 'detached', timeout: 8000 })

  // Tekrar önerisi: iki konuşmada aynı sırayla yazılan iki istem.
  await page.locator('body').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+Shift+P')
  await page.keyboard.type('hazır istemler')
  await page.keyboard.press('Enter')
  const manager = page.locator('.prompts-dialog')
  const suggestion = manager.locator('.prompt-row.suggestion').first()
  await suggestion.waitFor()
  assert.deepEqual(await suggestion.locator('.prompt-step-list li').allTextContents(), flow)
  if (shots) await page.screenshot({ path: path.join(shots, 'prompts-suggestions.png') })
  await suggestion.getByRole('button', { name: 'Kaydet' }).click()
  assert.equal(await manager.locator('.prompt-editor input').inputValue(), 'Testleri çalıştır ve kırılanları düzelt +1')
  await manager.locator('.prompt-editor input').fill('Bitir ve commit at')
  if (shots) await page.screenshot({ path: path.join(shots, 'prompts-editor.png') })
  await manager.getByRole('button', { name: 'Kaydet' }).click()
  await manager.locator('.prompt-row:not(.suggestion) strong', { hasText: 'Bitir ve commit at' }).waitFor()
  assert.equal(await manager.locator('.prompt-row.suggestion').count(), 0, 'kaydedilen öneri listeden düşer')
  if (shots) await page.screenshot({ path: path.join(shots, 'prompts-saved.png') })

  // Gönder: iki adım sırayla gider.
  await manager.getByRole('button', { name: 'Gönder' }).click()
  await manager.locator('.prompts-notice').waitFor()
  await until(() => lines().length === 5, 30000)
  assert.deepEqual(lines().slice(3), flow)
  await manager.getByRole('button', { name: 'Kapat' }).click()

  // Palet, odaktaki oturum için hazır istemi önerir.
  await page.keyboard.press('Control+Shift+P')
  await page.locator('.palette-section', { hasText: 'Hazır istemler' }).waitFor()
  await page.waitForTimeout(300)
  if (shots) await page.screenshot({ path: path.join(shots, 'prompts-palette.png') })
  await page.keyboard.press('Escape')

  assert.deepEqual(errors, [])
  console.log('prompts: ok')
} finally {
  await browser?.close()
  await daemon.close()
  fs.rmSync(root, { recursive: true, force: true })
}
