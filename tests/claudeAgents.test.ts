import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createClaudeAgents, parseAgents, parseStartedId } from '../src/server/claudeAgents'
import { tempDir, removeDir } from './helpers'

test('claude agents çıktısından yalnız açılabilir arka plan oturumları alınır', () => {
  const agents = parseAgents(JSON.stringify([
    { id: '93befcf9', cwd: '/p', kind: 'background', startedAt: 5, sessionId: 'x', name: 'ekran yirtilmasi', state: 'done' },
    { id: 'cf400df0', cwd: '/p', kind: 'background', state: 'blocked', status: 'idle' },
    { cwd: '/p', kind: 'interactive', pid: 12, sessionId: 'y' },
    { id: '../evil', cwd: '/p' },
  ]))
  assert.deepEqual(agents.map((a) => [a.id, a.name, a.state]), [['93befcf9', 'ekran yirtilmasi', 'done'], ['cf400df0', 'cf400df0', 'blocked']])
  assert.throws(() => parseAgents('{}'))
})

test('liste CLI ile okunur, özet iç dosyadan eklenir; CLI yoksa hata söylenir', async () => {
  const dir = tempDir()
  try {
    const fake = path.join(dir, 'claude')
    fs.writeFileSync(fake, `#!/bin/sh\n[ "$1 $2 $3 $4" = "agents --json --all --cwd" ] || exit 3\necho '[{"id":"2b879538","cwd":"'"$5"'","name":"multi-language","state":"working"}]'\n`, { mode: 0o755 })
    fs.mkdirSync(path.join(dir, 'jobs', '2b879538'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'jobs', '2b879538', 'state.json'), JSON.stringify({ detail: 'Round 3\n tamam', updatedAt: '2026-09-23T10:00:00.000Z' }))
    const agents = createClaudeAgents({ command: fake, claudeDir: dir, env: process.env })
    assert.equal(agents.cached(dir), null, 'ilk okuma beklenmez')
    const listed = await agents.list(dir)
    assert.equal(listed.error, null)
    assert.deepEqual(listed.agents[0], {
      id: '2b879538', name: 'multi-language', state: 'working', cwd: dir, sessionId: null, startedAt: null,
      updatedAt: Date.parse('2026-09-23T10:00:00.000Z'), detail: 'Round 3 tamam',
    })
    const missing = await createClaudeAgents({ command: path.join(dir, 'yok'), claudeDir: dir, env: process.env }).list(dir)
    assert.equal(missing.error, 'claude komutu bulunamadı')
  } finally {
    removeDir(dir)
  }
})

test('claude --bg çıktısından kısa kimlik okunur', () => {
  assert.equal(parseStartedId('backgrounded · \u001b[36m7c8569b3\u001b[39m · Çeviri (idle — send a prompt to start)\n'), '7c8569b3')
  assert.equal(parseStartedId('Error: not logged in'), null)
})
