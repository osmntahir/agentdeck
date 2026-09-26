import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyUsageLines, emptyUsageState, readAssistantUsage } from '../src/server/transcriptUsage'
import { contextFill, contextWindowFor, formatCost, formatTokens, messageUsage, modelLabel } from '../src/shared/usage'

const line = (value: object) => `${JSON.stringify(value)}\n`
const assistant = (id: string, usage: object, extra: object = {}, model = 'claude-opus-5-5') =>
  line({ type: 'assistant', timestamp: '2026-09-26T10:00:00.000Z', ...extra, message: { model, id, content: [{ type: 'text', text: 'tamam' }], usage } })

test('aynı mesajın her içerik bloğu satırı bir kez sayılır', () => {
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }
  const text = assistant('msg_1', usage) + assistant('msg_1', usage) + assistant('msg_2', { ...usage, output_tokens: 50 })
  const { usage: result } = applyUsageLines(emptyUsageState(), text)
  assert.equal(result.total.input, 20)
  assert.equal(result.total.output, 150)
  assert.equal(result.total.cacheRead, 2000)
  assert.equal(result.total.cacheWrite, 1000)
  assert.equal(result.context?.tokens, 10 + 1000 + 500 + 50)
  assert.equal(result.context?.window, 1_000_000)
  assert.equal(result.context?.at, Date.parse('2026-09-26T10:00:00.000Z'))
})

test('mesaj iki okumaya bölünse de bir kez sayılır', () => {
  const usage = { input_tokens: 1, output_tokens: 10 }
  const first = applyUsageLines(emptyUsageState(), assistant('msg_1', { input_tokens: 1, output_tokens: 3 }))
  const second = applyUsageLines(first, assistant('msg_1', usage))
  assert.equal(second.usage.total.output, 10)
})

test('yan zincir maliyete girer, bağlamı değiştirmez; sentetik mesaj sayılmaz', () => {
  const text =
    assistant('msg_1', { input_tokens: 100, output_tokens: 0 }) +
    assistant('msg_2', { input_tokens: 9000, output_tokens: 0 }, { isSidechain: true }) +
    assistant('msg_3', { input_tokens: 5, output_tokens: 5 }, {}, '<synthetic>')
  const { usage } = applyUsageLines(emptyUsageState(), text)
  assert.equal(usage.total.input, 9100)
  assert.equal(usage.context?.tokens, 100)
})

test('JSON olarak çözülemeyecek kadar uzun satırda usage yine okunur', () => {
  const huge = 'x'.repeat(300 * 1024)
  const raw = JSON.stringify({ type: 'assistant', isSidechain: false, message: { model: 'claude-sonnet-5', id: 'msg_big', content: [{ type: 'tool_use', input: { content: huge, note: '"usage":{"input_tokens":999}' } }], usage: { input_tokens: 7, output_tokens: 11 } }, timestamp: '2026-09-26T10:00:00.000Z' })
  const found = readAssistantUsage(raw)
  assert.equal(found?.id, 'msg_big')
  assert.equal(found?.model, 'claude-sonnet-5')
  assert.deepEqual(found?.usage, { input_tokens: 7, output_tokens: 11 })
})

test('maliyet önbellek türüne göre hesaplanır; bilinmeyen model eksik işaretlenir', () => {
  // Opus 5.5: giriş $4, çıkış $20, okuma $0,20, 5 dk yazma 1,25x, 1 sa yazma 2x.
  const cost = messageUsage('claude-opus-5-5', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 },
  }).costUsd!
  assert.ok(Math.abs(cost - (4 + 20 + 0.2 + 5 + 8)) < 1e-9, String(cost))
  assert.ok(Math.abs(messageUsage('claude-sonnet-5', { input_tokens: 1_000_000, speed: 'standard' }).costUsd! - 2) < 1e-9)
  const unknown = messageUsage('claude-gelecek-9', { input_tokens: 10 })
  assert.equal(unknown.costUsd, null)
  assert.equal(unknown.costPartial, true)
  assert.equal(messageUsage('claude-sonnet-5', { input_tokens: 10, speed: 'fast' }).costPartial, true, 'hızlı mod fiyatı bilinmiyor')
  assert.ok(Math.abs(messageUsage('claude-opus-5', { output_tokens: 1_000_000, speed: 'fast' }).costUsd! - 50) < 1e-9)
})

test('model kimliği tarih veya pencere ekiyle de tanınır', () => {
  assert.equal(contextWindowFor('claude-haiku-4-5-20251001'), 200_000)
  assert.equal(contextWindowFor('claude-opus-5-5[1m]'), 1_000_000)
  assert.equal(contextWindowFor('claude-opus-5'), 1_000_000)
  assert.equal(contextWindowFor('gpt-5'), null)
  assert.equal(contextFill({ model: 'x', tokens: 300_000, window: 200_000, at: null }), 1)
})

test('biçimler kısa ve Türkçe ondalıklıdır', () => {
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(12_400), '12k')
  assert.equal(formatTokens(8_400), '8,4k')
  assert.equal(formatTokens(1_250_000), '1,25M')
  assert.equal(formatTokens(2_000_000), '2M')
  assert.equal(formatTokens(34_500_000), '34,5M')
  assert.equal(formatCost(0.004), '<$0,01')
  assert.equal(formatCost(3.456), '$3,46')
  assert.equal(formatCost(0), '$0,00')
  assert.equal(formatCost(null), null)
})

test('model adı kısa gösterilir', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(modelLabel('claude-fable-5-1[1m]'), 'Fable 5.1')
  assert.equal(modelLabel('gpt-5-codex'), 'gpt-5-codex')
})
