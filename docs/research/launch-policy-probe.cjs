// LaunchPolicy izin listesinin referans uygulaması ve testi.
// Bağımlılık yok: `node launch-policy-probe.cjs`
//
// Sözleşme (spec §3): yalnız **argümansız literal** claude/gemini/codex
// çağrısı yönetilen konuşma eylemleri alır. Diğer her Command geçerlidir ve
// kabuğa aynen gider — AgentDeck hiçbir bayrak ekleyip silmez.
//
// Bu dosya kara liste tutmaz. Kara liste CLI sürümleriyle eskiyordu:
// `gemini --session-file` listede olmadığı için enjekte edilen `--session-id`
// ile çakışıp kullanıcının komutunu bozuyordu (ölçüldü).
const assert = require('node:assert/strict')

const MANAGED_CLIS = new Set(['claude', 'gemini', 'codex'])

/**
 * @param {string|null} command  Session kaydındaki kullanıcı niyeti.
 * @returns {{managed:boolean, cli:string|null, reason:string}}
 */
function classify(command) {
  if (command === null) return {managed: false, cli: null, reason: 'interaktif login kabuğu'}
  if (typeof command !== 'string') return {managed: false, cli: null, reason: 'geçersiz tip'}

  const trimmed = command.trim()
  if (trimmed === '') return {managed: false, cli: null, reason: 'boş komut (API 400)'}

  // Tek bir token olmalı: boşluk, kabuk metakarakteri, quote, newline yok.
  // Bu test kasten katıdır — şüphe varsa genel kabuk yoluna düşer.
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(trimmed)) {
    return {managed: false, cli: null, reason: 'tek literal token değil; kabuk programı olarak aynen çalışır'}
  }
  if (!MANAGED_CLIS.has(trimmed)) {
    return {managed: false, cli: null, reason: 'tanınan CLI değil; aynen çalışır'}
  }
  return {managed: true, cli: trimmed, reason: 'argümansız literal tanınan CLI'}
}

/**
 * Yönetilen olsa bile, o CLI+sürüm çifti insan kabul testinden geçmediyse
 * yalnız literal çalıştırma ve CLI'ın kendi seçicisi sunulur (spec §3).
 */
function availableActions(command, verifiedClis = new Set()) {
  const c = classify(command)
  const actions = ['run', 'picker']            // her zaman: aynen çalıştır + CLI seçicisi
  if (c.managed && verifiedClis.has(c.cli)) actions.push('fresh', 'resume')
  return actions
}

if (require.main === module) {
  const rows = []
  const t = (cmd, managed, note) => {
    const r = classify(cmd)
    assert.equal(r.managed, managed, `beklenen managed=${managed}: ${JSON.stringify(cmd)} → ${r.reason}`)
    rows.push({komut: cmd === null ? '(null)' : cmd, yönetilen: r.managed, gerekçe: r.reason, not: note})
  }

  // Yönetilen olabilecek tek biçim
  t('claude', true, 'preset')
  t('gemini', true, 'preset')
  t('codex', true, 'preset')
  t('  claude  ', true, 'trim edilir')

  // Kapıda adı geçen bayraklı komutlar — hiçbiri dokunulmadan geçmeli
  t('gemini --session-file ./s.json', false, 'CLI çakışması ölçüldü')
  t('gemini --list-sessions', false, null)
  t('gemini --delete-session 3', false, null)
  t('claude --from-pr 42', false, null)
  t('claude --resume', false, 'kullanıcının kendi seçicisi')
  t('claude --resume 1e4d2f80-0000-4000-8000-000000000000', false, 'kullanıcının kendi kimliği')
  t('codex resume', false, 'alt komut')
  t('claude -p "resume the task"', false, 'quote içinde resume sözcüğü')
  t('claude -- --resume', false, '-- sonrası prompt')

  // Kabuk programları
  t('FOO=1 claude', false, 'env öneki')
  t('env FOO=1 claude', false, 'wrapper')
  t('npx claude', false, 'wrapper')
  t('/home/u/.local/bin/claude', false, 'mutlak yol')
  t('"claude"', false, 'quote edilmiş')
  t('claude | tee log.txt', false, 'pipeline')
  t('claude && echo ok', false, 'liste')
  t('claude $(pwd)', false, 'expansion')
  t('claude\nls', false, 'newline')
  t('cd /tmp && claude', false, 'bileşik')
  t('CLAUDE', false, 'büyük harf farklı program')
  t('claude2', false, 'farklı isim')
  t(null, false, 'interaktif kabuk')
  t('', false, 'boş')

  console.table(rows)

  // Doğrulanmamış CLI'da yönetilen eylem açılmaz
  assert.deepEqual(availableActions('claude', new Set()), ['run', 'picker'])
  assert.deepEqual(availableActions('claude', new Set(['claude'])), ['run', 'picker', 'fresh', 'resume'])
  assert.deepEqual(availableActions('gemini --session-file ./s.json', new Set(['gemini'])), ['run', 'picker'])

  console.log('\nTÜM LAUNCHPOLICY ASSERTION\'LARI GEÇTİ')
  console.log('Yönetilen eylem yalnız: argümansız literal tanınan CLI + kabul testinden geçmiş sürüm.')
}

module.exports = {classify, availableActions}
