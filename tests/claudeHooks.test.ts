import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { HOOK_COMMAND, installClaudeHook, openHookInbox, parseHookEvent, type HookEvent } from '../src/server/claudeHooks'
import { tempDir, removeDir } from './helpers'

const SID = 'a'.repeat(32)
const RUN = 'b'.repeat(32)
const CONVERSATION = '520c6040-e55e-4389-b0f2-108811f05310'

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

test('kanca yoksa ayar dosyası oluşturulur, ikinci kurulum dosyayı değiştirmez', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    assert.deepEqual(installClaudeHook(file), { active: true, changed: true })
    assert.equal(readJson(file).hooks.SessionStart[0].hooks[0].command, HOOK_COMMAND)
    const before = fs.readFileSync(file, 'utf8')
    assert.deepEqual(installClaudeHook(file), { active: true, changed: false })
    assert.equal(fs.readFileSync(file, 'utf8'), before)
  } finally {
    removeDir(dir)
  }
})

test('kullanıcının diğer ayarları ve kancaları korunur; eski AgentDeck kancası güncellenir', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    const own = { type: 'command', command: 'echo kendi' }
    fs.writeFileSync(file, JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [{ hooks: [own] }],
        SessionStart: [{ matcher: 'startup', hooks: [own, { type: 'command', command: 'eski $AGENTDECK_HOOK_DIR' }] }],
      },
    }), { mode: 0o640 })
    assert.deepEqual(installClaudeHook(file), { active: true, changed: true })
    const next = readJson(file)
    assert.equal(next.model, 'opus')
    assert.deepEqual(next.hooks.Stop, [{ hooks: [own] }])
    assert.equal(next.hooks.SessionStart.length, 1)
    assert.equal(next.hooks.SessionStart[0].matcher, 'startup')
    assert.deepEqual(next.hooks.SessionStart[0].hooks, [own, { type: 'command', command: HOOK_COMMAND }])
    assert.equal(fs.statSync(file).mode & 0o777, 0o640)
  } finally {
    removeDir(dir)
  }
})

test('okunamayan veya beklenmedik ayar dosyasına dokunulmaz', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'settings.json')
    for (const content of ['{ bozuk', '[]', '{"hooks": []}', '{"hooks": {"SessionStart": {}}}']) {
      fs.writeFileSync(file, content)
      const result = installClaudeHook(file)
      assert.equal(result.active, false, content)
      assert.equal(fs.readFileSync(file, 'utf8'), content)
    }
  } finally {
    removeDir(dir)
  }
})

test('symlink ayar dosyası symlink olarak kalır', () => {
  const dir = tempDir()
  try {
    const real = path.join(dir, 'dotfiles-settings.json')
    const link = path.join(dir, 'settings.json')
    fs.writeFileSync(real, '{"theme":"dark"}')
    fs.symlinkSync(real, link)
    assert.equal(installClaudeHook(link).active, true)
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(readJson(real).theme, 'dark')
    assert.equal(readJson(real).hooks.SessionStart[0].hooks[0].command, HOOK_COMMAND)
  } finally {
    removeDir(dir)
  }
})

test('kanca komutu AgentDeck dışında hiçbir şey yazmaz; içinde olay dosyası bırakır', () => {
  const dir = tempDir()
  try {
    const input = JSON.stringify({ session_id: CONVERSATION, source: 'clear', hook_event_name: 'SessionStart' })
    const outside = execFileSync('sh', ['-c', HOOK_COMMAND], { input, env: { PATH: process.env.PATH } })
    assert.equal(outside.length, 0)
    assert.deepEqual(fs.readdirSync(dir), [])

    const inside = execFileSync('sh', ['-c', HOOK_COMMAND], {
      input,
      env: { PATH: process.env.PATH, AGENTDECK_HOOK_DIR: dir, AGENTDECK_SESSION: SID, AGENTDECK_RUN: RUN },
    })
    assert.equal(inside.length, 0, 'SessionStart çıktısı Claude bağlamına girerdi')
    const [name] = fs.readdirSync(dir)
    const event = parseHookEvent(name!, fs.readFileSync(path.join(dir, name!), 'utf8'), 1)
    assert.deepEqual(event, { sessionId: SID, runId: RUN, conversationId: CONVERSATION, source: 'clear', transcriptPath: null, at: 1 })
  } finally {
    removeDir(dir)
  }
})

test('olay ayrıştırma yalnız geçerli kimlikleri kabul eder', () => {
  const body = (extra: object) => JSON.stringify({ session_id: CONVERSATION, ...extra })
  assert.equal(parseHookEvent(`${SID}.${RUN}.1.json`, body({ source: 'startup', transcript_path: '/t.jsonl' }), 5)?.transcriptPath, '/t.jsonl')
  assert.equal(parseHookEvent(`${SID}.${RUN}.1.json`, body({ source: 'yeni-bir-sey' }), 5)?.source, 'other')
  assert.equal(parseHookEvent(`${SID}.${RUN}.1.json`, body({ transcript_path: 'goreli.jsonl' }), 5)?.transcriptPath, null)
  assert.equal(parseHookEvent(`${SID}.${RUN}.1.json`, body({ hook_event_name: 'Stop' }), 5), null)
  assert.equal(parseHookEvent(`../x.${RUN}.1.json`, body({}), 5), null)
  assert.equal(parseHookEvent(`${SID}.${RUN}.1.json`, JSON.stringify({ session_id: 'latest' }), 5), null)
  assert.equal(parseHookEvent(`${SID}.${RUN}.1.json`, '{bozuk', 5), null)
})

test('olay kutusu dosyaları bir kez okur ve siler; yarım dosyaya dokunmaz', () => {
  const dir = tempDir()
  const seen: HookEvent[] = []
  const inbox = openHookInbox(dir, (events) => seen.push(...events), 60_000)
  try {
    fs.writeFileSync(path.join(dir, `${SID}.${RUN}.7.json`), JSON.stringify({ session_id: CONVERSATION, source: 'startup' }))
    fs.writeFileSync(path.join(dir, `${SID}.${RUN}.8.tmp`), '{')
    fs.writeFileSync(path.join(dir, 'bozuk.json'), '{')
    inbox.drain()
    inbox.drain()
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.conversationId, CONVERSATION)
    assert.deepEqual(fs.readdirSync(dir), [`${SID}.${RUN}.8.tmp`])
  } finally {
    inbox.close()
    removeDir(dir)
  }
})
