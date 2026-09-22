import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fuzzyScore } from '../src/shared/fuzzy'

test('boş sorgu her şeyle eşleşir', () => {
  assert.equal(fuzzyScore('', 'Ödeme akışı'), 0)
})

test('her kelime ayrı ayrı eşleşmelidir', () => {
  assert.notEqual(fuzzyScore('claude kiosk', 'Claude Code · kiosk-api'), null)
  assert.equal(fuzzyScore('claude web', 'Claude Code · kiosk-api'), null)
})

test('Türkçe büyük harfler doğru küçülür', () => {
  assert.notEqual(fuzzyScore('ödeme', 'ÖDEME AKIŞI'), null)
  assert.notEqual(fuzzyScore('akışı', 'ÖDEME AKIŞI'), null)
})

test('harf sırası korunan kısaltma eşleşir, ters sıra eşleşmez', () => {
  assert.notEqual(fuzzyScore('gbl', 'Grafik bileşeni'), null)
  assert.equal(fuzzyScore('lbg', 'Grafik bileşeni'), null)
})

test('doğrudan ve kelime başı eşleşme daha üstte sıralanır', () => {
  const word = fuzzyScore('test', 'Testleri çalıştır')!
  const inner = fuzzyScore('test', 'Kontestler')!
  const scattered = fuzzyScore('test', 'The eastern street')!
  assert(word > inner, `${word} > ${inner}`)
  assert(inner > scattered, `${inner} > ${scattered}`)
})
