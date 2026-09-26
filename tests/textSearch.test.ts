import { test } from 'node:test'
import assert from 'node:assert/strict'
import { foldText, makeSnippet, searchTerms } from '../src/shared/textSearch'
import { matchMessages, readSearchLines } from '../src/server/transcriptSearch'

const line = (value: object) => `${JSON.stringify(value)}\n`

test('katlama harf ve Türkçe işaretleri yok sayar, uzunluğu korur', () => {
  for (const [input, folded] of [['Görev', 'gorev'], ['İSTANBUL', 'istanbul'], ['ılık ŞİŞ', 'ilik sis'], ['Çağrı', 'cagri'], ['emoji 🙂 ok', 'emoji 🙂 ok']]) {
    assert.equal(foldText(input!), folded)
    assert.equal(foldText(input!).length, input!.length)
  }
  assert.deepEqual(searchTerms('  Port  PORT çakışma '), ['port', 'cakisma'])
})

test('parça ilk eşleşmenin çevresinden alınır ve eşleşmeler işaretlenir', () => {
  const text = `${'önce '.repeat(40)}bu port çakışması Vite ile oluyor ve port değişiyor${' sonra'.repeat(40)}`
  const snippet = makeSnippet(text, foldText(text), searchTerms('port vite'))
  assert.ok(snippet.text.startsWith('…'))
  assert.ok(snippet.text.endsWith('…'))
  const marked = snippet.ranges.map(([a, b]) => snippet.text.slice(a, b))
  assert.deepEqual(marked, ['port', 'Vite', 'port'])
})

test('dizin yalnız kullanıcı istemlerini ve ajanın düz metnini alır', () => {
  const text =
    line({ type: 'user', timestamp: '2026-09-26T10:00:00Z', message: { content: 'Ödeme sayfasındaki <pasted_content id="1">hata</pasted_content id="1"> düzelt' } }) +
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'araç çıktısı gizli' }] } }) +
    line({ type: 'user', isMeta: true, message: { content: 'meta' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'düşünce' }, { type: 'text', text: 'Stripe webhook imzasını düzelttim.' }] } }) +
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { command: 'rm -rf' } }] } }) +
    '{"type":"user","message":{"content":"yarım'
  const { messages, consumed } = readSearchLines(text)
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ['user', 'Ödeme sayfasındaki hata düzelt'],
    ['assistant', 'Stripe webhook imzasını düzelttim.'],
  ])
  assert.equal(messages[0]!.at, Date.parse('2026-09-26T10:00:00Z'))
  assert.equal(consumed, Buffer.byteLength(text) - Buffer.byteLength('{"type":"user","message":{"content":"yarım'))
})

test('bütün terimler konuşmada geçmeli; en çok terim içeren mesaj seçilir', () => {
  const { messages } = readSearchLines(
    line({ type: 'user', message: { content: 'ödeme sayfasını incele' } }) +
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Stripe webhook imzası hatalı' }] } }) +
    line({ type: 'user', message: { content: 'stripe ödeme akışını düzelt' } }),
  )
  const match = matchMessages(messages, searchTerms('odeme stripe'))
  assert.equal(match?.role, 'user')
  assert.equal(match?.snippet.text, 'stripe ödeme akışını düzelt')
  assert.equal(match?.matches, 3)
  assert.equal(matchMessages(messages, searchTerms('odeme paypal')), null)
})
