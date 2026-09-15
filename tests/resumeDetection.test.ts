import assert from 'node:assert/strict'
import test from 'node:test'
import { resumeTargetFromTerminalText } from '../src/shared/resumeDetection'

const UUID = '12345678-1234-1234-1234-123456789abc'

for (const [cli, footer, shown, command] of [
  ['claude', 'Resume this session with:', `claude --resume ${UUID}`, `claude --resume ${UUID}`],
  ['codex', 'To resume this session:', `codex resume ${UUID}`, `codex resume ${UUID}`],
  ['gemini', 'Resume this session with:', `gemini --resume ${UUID}`, `gemini --resume ${UUID}`],
  ['grok', 'To resume:', `grok --resume ${UUID}`, `grok --resume ${UUID}`],
  ['opencode', 'Continue this session with:', `opencode --session ${UUID}`, `opencode --session ${UUID}`],
  ['agy', 'Resume with -c (or command below):', `agy --conversation=${UUID}`, `agy --conversation=${UUID}`],
] as const) {
  test(`${cli} footerındaki resume komutu kalıcı hedef sayılır`, () => {
    assert.deepEqual(
      resumeTargetFromTerminalText(`\u001b[32m${footer}\u001b[0m\n${shown}`),
      { cli, conversationId: UUID, command },
    )
  })
}

test('footer olmadan görünen komut konuşma kimliği olarak kaydedilmez', () => {
  assert.equal(resumeTargetFromTerminalText(`Try claude --resume ${UUID} later`), null)
})
