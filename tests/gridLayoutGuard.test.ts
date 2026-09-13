import assert from 'node:assert/strict'
import test from 'node:test'
import { GRID_LAYOUT_TEXT_LIMIT, MAX_GRID_PANELS, parseGridLayoutJson } from '../src/shared/gridLayoutGuard'

function panel(id: string) {
  return { id, contentComponent: 'terminal', params: { sessionId: id } }
}

test('boş veya aşırı kayıt yerleşim olarak kabul edilmez', () => {
  assert.equal(parseGridLayoutJson(null), null)
  assert.equal(parseGridLayoutJson(''), null)
  assert.equal(parseGridLayoutJson('{'), null)
  assert.equal(parseGridLayoutJson('[]'), null)
  assert.equal(parseGridLayoutJson(JSON.stringify({ panels: [] })), null)
  assert.equal(parseGridLayoutJson('x'.repeat(GRID_LAYOUT_TEXT_LIMIT + 1)), null)
})

test('panel kimliği, bileşen ve Session id tutarlıdır; 8 panel sınırı aşılmaz', () => {
  const ok = parseGridLayoutJson(JSON.stringify({ panels: { a: panel('a'), b: panel('b') } }))
  assert.deepEqual(ok && Object.keys(ok.panels), ['a', 'b'])

  assert.equal(parseGridLayoutJson(JSON.stringify({ panels: { a: panel('b') } })), null)
  assert.equal(parseGridLayoutJson(JSON.stringify({ panels: { a: { ...panel('a'), contentComponent: 'other' } } })), null)
  assert.equal(parseGridLayoutJson(JSON.stringify({ panels: { a: { ...panel('a'), params: { sessionId: 'b' } } } })), null)

  const panels = Object.fromEntries(Array.from({ length: MAX_GRID_PANELS + 1 }, (_, i) => [`p${i}`, panel(`p${i}`)]))
  assert.equal(parseGridLayoutJson(JSON.stringify({ panels })), null)
  const allowed = Object.fromEntries(Array.from({ length: MAX_GRID_PANELS }, (_, i) => [`p${i}`, panel(`p${i}`)]))
  assert.equal(Object.keys(parseGridLayoutJson(JSON.stringify({ panels: allowed }))!.panels).length, MAX_GRID_PANELS)
})
