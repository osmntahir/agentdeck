import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTranscriptLines } from '../src/server/transcripts'

const EMPTY = { title: null, firstPrompt: null, lastPrompt: null, updatedAt: null }
const line = (value: object) => `${JSON.stringify(value)}\n`

test('özet kullanıcı istemlerini, adı ve son istemi okur; komut ve meta satırlarını atlar', () => {
  const text =
    line({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>…</local-command-caveat>' } }) +
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
    line({ type: 'user', message: { role: 'user', content: '\n\n<pasted_content id="1">\nÇoklu dil   desteği ekle\n</pasted_content id="1">' } }) +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'çıktı' }] } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'tamam' }] } }) +
    line({ type: 'custom-title', customTitle: 'ekran yirtilmasi', sessionId: 'x' }) +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'draft pr ları açar mısın' }] } })
  const { summary, consumed } = applyTranscriptLines(EMPTY, text)
  assert.equal(consumed, Buffer.byteLength(text))
  assert.deepEqual(summary, {
    title: 'ekran yirtilmasi',
    firstPrompt: 'Çoklu dil desteği ekle',
    lastPrompt: 'draft pr ları açar mısın',
    updatedAt: null,
  })
})

test('yarım son satır sonraki okumaya kalır', () => {
  const full = line({ type: 'last-prompt', lastPrompt: 'devam et' })
  const partial = '{"type":"user","message":{"content":"yarı'
  const { summary, consumed } = applyTranscriptLines(EMPTY, full + partial)
  assert.equal(consumed, Buffer.byteLength(full))
  assert.equal(summary.lastPrompt, 'devam et')
  assert.equal(summary.firstPrompt, null)
})

test('uzun istem kısaltılır', () => {
  const { summary } = applyTranscriptLines(EMPTY, line({ type: 'user', message: { content: 'a'.repeat(500) } }))
  assert.equal(summary.firstPrompt!.length, 160)
  assert.ok(summary.firstPrompt!.endsWith('…'))
})
