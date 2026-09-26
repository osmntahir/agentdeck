import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectRepeatedPrompts, promptKey, suggestedName, type PromptHistory, type SavedPrompt } from '../src/shared/prompts'

const conversation = (...texts: string[]): PromptHistory => ({ prompts: texts.map((text, i) => ({ text, at: 1000 + i })) })

test('istem anahtarı harf, işaret ve noktalamadan bağımsızdır', () => {
  assert.equal(promptKey('  Testleri ÇALIŞTIR, kırılanları düzelt! '), 'testleri calistir kirilanlari duzelt')
})

test('en az 3 kez ve 2 konuşmada yazılan istem önerilir; benzer yazılışlar birleşir', () => {
  const suggestions = detectRepeatedPrompts([
    conversation('testleri çalıştır ve kırılanları düzelt', 'ödeme sayfasını yap'),
    conversation('Testleri çalıştır, kırılanları düzelt.'),
    conversation('testleri çalıştır kırılanları düzelt lütfen', 'evet'),
  ], [])
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0]!.count, 3)
  assert.equal(suggestions[0]!.conversations, 3)
  assert.deepEqual(suggestions[0]!.steps, ['testleri çalıştır kırılanları düzelt lütfen'], 'en yeni yazılış gösterilir')
})

test('tek konuşmada tekrarlanan veya kısa istem önerilmez', () => {
  assert.deepEqual(detectRepeatedPrompts([conversation('lint hatalarını düzelt', 'lint hatalarını düzelt', 'lint hatalarını düzelt')], []), [])
  assert.deepEqual(detectRepeatedPrompts([conversation('devam'), conversation('devam'), conversation('devam')], []), [])
})

test('arka arkaya yazılan istem dizisi önerilir; parçası ayrıca önerilmez', () => {
  const flow = ['testleri çalıştır ve düzelt', 'değişiklikleri commit et', 'pull request aç']
  const suggestions = detectRepeatedPrompts([
    conversation('ödeme sayfası yap', ...flow),
    conversation('readme güncelle', ...flow),
  ], [])
  assert.deepEqual(suggestions.map((s) => s.steps), [flow])
  assert.equal(suggestions[0]!.conversations, 2)
})

test('kayıtlı hazır istemle aynı öneri gösterilmez', () => {
  const saved: SavedPrompt[] = [{ id: 'p', name: 'Test', steps: ['Testleri çalıştır ve kırılanları düzelt'], createdAt: 0 }]
  const history = [1, 2, 3].map(() => conversation('testleri çalıştır ve kırılanları düzelt'))
  assert.deepEqual(detectRepeatedPrompts(history, saved), [])
})

test('öneri adı ilk adımın ilk kelimelerinden gelir', () => {
  assert.equal(suggestedName(['testleri çalıştır ve kırılanları hemen düzelt']), 'testleri çalıştır ve kırılanları hemen')
  assert.equal(suggestedName(['commit et', 'pr aç']), 'commit et +1')
})
