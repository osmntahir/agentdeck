import assert from 'node:assert/strict'
import test from 'node:test'
import { explicitResumeCommand, explicitResumeOf, launchCli } from '../src/shared/launchPolicy'

test('yalnız argümansız literal CLI yönetilen kısayola uygundur', () => {
  assert.equal(launchCli(' claude '), 'claude')
  assert.equal(launchCli('codex'), 'codex')
  assert.equal(launchCli('gemini'), 'gemini')
  for (const command of [null, '', 'claude --resume', 'gemini --session-file x', 'codex resume',
    '"claude"', '/usr/bin/claude', 'env claude', 'FOO=1 claude', 'claude | cat',
    'claude; codex', '$(echo claude)', 'claude\ncodex', 'claude -- prompt']) {
    assert.equal(launchCli(command), null, String(command))
  }
})

test('kullanıcının açık UUID komutu tam hedefi korur; otomatik devam seçmez', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  assert.equal(explicitResumeCommand('claude', id), `claude --resume ${id}`)
  assert.equal(explicitResumeCommand('codex', ` ${id} `), `codex resume ${id}`)
  assert.equal(explicitResumeCommand('gemini', id), `gemini --resume ${id}`)
  for (const invalid of ['', 'latest', '--last', '1', 'conversation name', '../file.json',
    `${id}; touch marker`, `${id}\nexit`, `$(echo ${id})`, `${id}'`, id.slice(0, -1)]) {
    assert.equal(explicitResumeCommand('claude', invalid), null)
  }
})

test('açık UUID komutu tanınır; seçici ve serbest komut konuşma adayı değildir', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  assert.deepEqual(explicitResumeOf(`claude --resume ${id}`), { cli: 'claude', conversationId: id })
  assert.equal(explicitResumeOf('claude --resume'), null)
  assert.equal(explicitResumeOf('claude'), null)
  assert.equal(explicitResumeOf(`claude --resume ${id}; rm -rf /`), null)
})
