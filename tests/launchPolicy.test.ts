import assert from 'node:assert/strict'
import test from 'node:test'
import {
  explicitResumeCommand,
  explicitResumeOf,
  lastLaunchFor,
  launchCli,
  pickerCli,
  repeatLaunchCommand,
} from '../src/shared/launchPolicy'

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
  assert.equal(explicitResumeCommand('agy', id), `agy --conversation=${id}`)
  assert.equal(explicitResumeCommand('grok', id), `grok --resume ${id}`)
  assert.equal(explicitResumeCommand('opencode', id), `opencode --session ${id}`)
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

test('picker yalnız tam seçici çağrısıdır', () => {
  assert.equal(pickerCli('claude --resume'), 'claude')
  assert.equal(pickerCli('codex resume'), 'codex')
  assert.equal(pickerCli('gemini --resume'), 'gemini')
  assert.equal(pickerCli('claude'), null)
  assert.equal(pickerCli('claude --resume x'), null)
})

test('yeniden çalıştırma lastLaunch niyetini command stringe çevirir', () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const base = { command: 'claude' as string | null, lastLaunch: null }
  assert.equal(repeatLaunchCommand({ ...base, lastLaunch: { mode: 'command', command: 'codex' } }), 'codex')
  assert.equal(repeatLaunchCommand({ ...base, lastLaunch: { mode: 'fresh', cli: 'gemini', conversationId: null } }), 'gemini')
  assert.equal(repeatLaunchCommand({ ...base, lastLaunch: { mode: 'picker', cli: 'claude' } }), 'claude --resume')
  assert.equal(
    repeatLaunchCommand({ ...base, lastLaunch: { mode: 'resume', cli: 'claude', conversationId: id } }),
    `claude --resume ${id}`,
  )
})

test('fresh ve picker lastLaunch UUID üretmez', () => {
  assert.deepEqual(lastLaunchFor('fresh', 'claude'), { mode: 'fresh', cli: 'claude', conversationId: null })
  assert.equal(lastLaunchFor('fresh', 'claude --resume'), null)
  assert.deepEqual(lastLaunchFor('picker', 'codex resume'), { mode: 'picker', cli: 'codex' })
  assert.equal(lastLaunchFor('picker', 'codex'), null)
  assert.deepEqual(lastLaunchFor('command', 'pwd'), { mode: 'command', command: 'pwd' })
})


test('desteklenmeyen eski launch başlangıç komutuna sessizce düşmez', () => {
  const command = 'echo unexpected'
  for (const lastLaunch of [
    { mode: 'picker' as const, cli: 'unknown' },
    { mode: 'fresh' as const, cli: 'unknown', conversationId: null },
    { mode: 'resume' as const, cli: 'claude', conversationId: 'invalid' },
  ]) assert.equal(repeatLaunchCommand({ command, lastLaunch }), undefined)
  assert.equal(repeatLaunchCommand({ command: null, lastLaunch: null }), null, 'kabuk geçerli komuttur')
})
