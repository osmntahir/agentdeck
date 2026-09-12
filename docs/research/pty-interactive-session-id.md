# Etkileşimli PTY'de ajan oturum kimliği: dayatma ve yakalama

> Tarihli araştırma kanıtı: aşağıdaki ölçümler o sürüm/ortama aittir. Güncel ürün politikası [spec revizyon 2](../specs/agentdeck-v0.md) ve [karar uzlaştırması](../reviews/2026-09-12-decision-reconciliation.md) içindedir. Buradaki öneriler yeni launch/preview sözleşmesini geçersiz kılmaz.

**Kapsam:** AgentDeck'in `exec claude` / `exec codex` / `exec gemini` ile açtığı **etkileşimli TUI** (PTY, TTY stdin/stdout) için oturum kimliğinin baştan dayatılıp dayatılamayacağı; dayatılamıyorsa süreç dışından, **PTY stdout'unu regex ile kazımadan** nasıl okunacağı; dayatılan id zaten varsa ne olduğu.

**Bu belgenin dışında:** Headless kimlik yolları (`claude -p --output-format json`, `codex exec --json`, `gemini --list-sessions`) birincil cevap değildir. Yalnızca etkileşimli TUI ile yan yana duran, ayrı bir süreçten çağrılabilen **yan kanal** oldukları ölçüldüğünde anılırlar. Resume sözdizimi ve cwd kapsamı [agent-cli-resume.md](./agent-cli-resume.md) / [#10](https://github.com/osmntahir/agentdeck/issues/10) kapsamındadır.

**Araştırma tarihi:** 2026-09-12

**Kontrol edilen sürümler** (hepsi bu makinede kurulu):

| CLI | Sürüm | Yol |
| --- | --- | --- |
| Claude Code | `2.1.269` (`claude --version`) | `/home/codexist/.local/bin/claude` |
| OpenAI Codex CLI | `codex-cli 0.154.0` (`codex --version`) | `/home/codexist/.nvm/versions/node/v22.19.0/bin/codex` |
| Google Gemini CLI | `0.59.0` (`gemini --version`) | `/home/codexist/.nvm/versions/node/v22.19.0/bin/gemini` |

**Yöntem notu:** `--help`, resmi doküman ve birinci taraf kaynak koda ek olarak, her CLI izole `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` altında bir PTY'de (`TERM=xterm-256color`, 120×32) başlatıldı. Deney sonuçları "**ölçüm**" olarak işaretlendi. Gemini bu makinede model çağrısı yapamıyor (`IneligibleTierError`); buna rağmen `--session-id` ayrıştırması, oturum dosyası yazımı, `SessionStart` kancası ve çakışma denetimi model çağrısı olmadan ölçüldü.

Bugünkü AgentDeck spawn'ı bayraksızdır: `exec ${cmd}` ve ortama yalnızca `AGENTDECK_SESSION` eklenir (`src/server/sessions.ts`). Oturum kaydında ajan oturum kimliği alanı yoktur (`src/shared/types.ts`).

---

## Özet tablo

| | `claude` 2.1.269 | `codex` 0.154.0 | `gemini` 0.59.0 |
| --- | --- | --- | --- |
| **Dayatma (etkileşimli)** | Evet: `claude --session-id <uuid>`. `--help` "must be a valid UUID". **Ölçüldü:** TUI açıldı, transcript `<uuid>.jsonl` yazıldı | **Yok.** `codex --session-id …` → `unexpected argument`, exit `2`. Açık id yalnızca `codex resume <id>` (devam ettirme, dayatma değil) | Evet: `gemini --session-id <id>`. `--help` "UUID" der; coerce aslında `[A-Za-z0-9-_]+`. **Ölçüldü:** TUI açıldı, `session-<ts>-<8-önek>.jsonl` yazıldı |
| **Scrape'siz yakalama** | `SessionStart` kancası: `session_id` + `transcript_path`. Dosya adı zaten UUID. OSC başlığı `"✳ Claude Code"` — id yok | `SessionStart` kancası: `session_id` + `transcript_path` (rollout yolu). Varsayılan OSC başlığı proje adı + spinner, id yok. `-c 'tui.terminal_title=["session-id"]'` OSC'ye **kısaltılmış** UUID basar (ölçüm: 32 karakter, `…`) | `SessionStart` kancası: `session_id` + `transcript_path` + `GEMINI_SESSION_ID`. Dosyanın ilk JSON satırında `sessionId`. OSC `"◇ Ready (<proje>)"` — id yok |
| **PTY stdout kazıma** | Gerekmez; TUI gövdesinde UUID basılmıyor (**ölçüm**) | Gerekmez. Çıkış anında `Session ID: <uuid>` satırı var — canlı TUI için işe yaramaz ve scrape'dir | Gerekmez; TUI gövdesinde UUID basılmıyor (**ölçüm**) |
| **Çakışma** | `Error: Session ID <uuid> is already in use.`, exit `1`. Resume olmaz, üzerine yazılmaz. Resume için `--resume` | Dayatma yok. Var olmayan id ile `codex resume <id>` hata verir ([#10](https://github.com/osmntahir/agentdeck/issues/10)) | `Error starting session: Session ID "…" already exists. Use --resume to resume it, or provide a different ID.`, exit `42`. Üzerine yazılmaz |

---

## 1. Claude Code (`claude` 2.1.269)

### 1.1 Dayatma

`--session-id <uuid>` etkileşimli modun bayrağıdır; `-p/--print` ile sınırlı değildir.

> `--session-id <uuid>` — "Use a specific session ID for the conversation (must be a valid UUID)"
> — `claude --help`; [cli-reference](https://code.claude.com/docs/en/cli-reference) örneği: `claude --session-id "550e8400-e29b-41d4-a716-446655440000"`

`--help` ayrıca şunu söyler: `--session-id`, `--continue` / `--resume` ile ancak `--fork-session` da varsa kullanılabilir.

**Ölçüm (ayrıştırma, PTY gerekmez):**

| Komut | Sonuç | Çıkış |
| --- | --- | --- |
| `claude --session-id not-a-uuid` | `Error: Invalid session ID. Must be a valid UUID.` | `1` |
| `claude --session-id <uuid> --resume <aynı-uuid>` (fork yok) | `Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.` | `1` |

**Ölçüm (etkileşimli PTY):** `CLAUDE_CONFIG_DIR` izole, cwd `/tmp/pty-sid-research/claude-work`, `hasTrustDialogAccepted: true`, `claude --session-id 259798fb-8b33-4eae-a26b-78115417b8bc --dangerously-skip-permissions`.

- TUI açıldı (`Claude Code v2.1.269`, bypass-permissions uyarısı).
- Transcript yazıldı: `$CLAUDE_CONFIG_DIR/projects/-tmp-pty-sid-research-claude-work/259798fb-8b33-4eae-a26b-78115417b8bc.jsonl`. İlk satır `"sessionId":"259798fb-8b33-4eae-a26b-78115417b8bc"`.
- `SessionStart` kancası aynı UUID'yi ve `transcript_path`'i verdi (`source: "startup"`).
- OSC 0 başlığı `"✳ Claude Code"` — UUID yok.
- PTY akışında UUID yok.

Dayatma, ilk kullanıcı mesajından ve model çağrısından önce gerçekleşir.

`--session-id` **yeni** oturum içindir; var olanı açmaz. Aynı kimliği sürdürmek `--resume <uuid>` işidir ([sessions](https://code.claude.com/docs/en/sessions)). Bu, aşağıda çakışmada da ölçüldü.

Yan kanal (headless, doğrulama): aynı UUID `claude -p --resume 259798fb-… --output-format json "Reply with exactly: OK"` ile exit `0` döndü ve JSON'daki `session_id` aynı kaldı. Bu, dayatılmış etkileşimli oturumun gerçekten resume edilebilir olduğunu gösterir; canlı TUI yakalama yolu değildir.

### 1.2 Yakalama (dayatma yoksa)

Dokümanın önerdiği programatik yüzey kancalar ve statusline'dır; transcript JSONL "iç kullanıma ait"tir ([sessions](https://code.claude.com/docs/en/sessions#access-conversations-from-scripts), [hooks](https://code.claude.com/docs/en/hooks#common-input-fields), [statusline](https://code.claude.com/docs/en/statusline#available-data)).

Ortak kanca/statusline alanları: `session_id`, `transcript_path`.

**Ölçüm (PTY, `--session-id` yok):** `claude --dangerously-skip-permissions`. Proje `.claude/settings.json` içinde `SessionStart` kancası.

Kanca stdin:

```json
{
  "session_id": "8146a071-73bb-466c-885b-cdc556de9956",
  "transcript_path": "…/projects/-tmp-pty-sid-research-claude-work/8146a071-73bb-466c-885b-cdc556de9956.jsonl",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

Aynı anda o `.jsonl` dosyası oluştu. Kanca çocuğunun ortamında `CLAUDE_CODE_SESSION_ID` de aynı UUID'ye set edilir (Claude bunu **dışarıdan okuyup dayatmaz**; kendisi yazar).

Dosya izleme: `~/.claude/projects/<cwd-slug>/*.jsonl` altında en yeni dosyanın adı UUID'dir. Kanca, dosya adını tahmin etmekten daha doğrudan bir sözleşmedir.

Statusline aynı `session_id` / `transcript_path` JSON'unu stdin'den alır; oturum başında bir kez çalışır. AgentDeck için `SessionStart` kancası yeter; statusline sürekli yenilenir, gerekmez.

### 1.3 PTY stdout kazıması

Önerilmez ve gerekmez. Etkileşimli TUI UUID basmaz (**ölçüm**). OSC başlığı da UUID taşımaz.

### 1.4 Çakışma

Kaynak (yerel ikili, 2.1.269): geçersiz UUID reddedilir; `CCt(id)` true ise ve `--fork-session` + `--resume` aynı id değilse `Error: Session ID ${id} is already in use.`

**Ölçüm:** Yukarıdaki `259798fb-…` oturumu `/exit` ile kapandıktan sonra aynı `--session-id` tekrar:

```
Error: Session ID 259798fb-8b33-4eae-a26b-78115417b8bc is already in use.
```

PTY, exit `1`. Transcript duruyordu. Davranış **hata**dır: resume değil, overwrite değil. Süreç ölmüş olsa bile diskteki transcript "in use" sayılır.

`--session-id` + `--resume` + `--fork-session` kombinasyonu ikili dizgede var; bu araştırmada fork yolu ölçülmedi.

---

## 2. OpenAI Codex CLI (`codex` 0.154.0)

### 2.1 Dayatma

**Yok.** Etkileşimli `codex` komutunda `--session-id` bayrağı tanımlı değil.

TUI CLI'sinde `resume_session_id` `#[clap(skip)]` — "Internal: resume a specific recorded session by id (UUID). Set by the top-level `codex resume <SESSION_ID>` wrapper; not exposed as a public flag." ([codex-rs/tui/src/cli.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/cli.rs))

**Ölçüm:** `codex --session-id 11111111-1111-1111-1111-111111111111`

```
error: unexpected argument '--session-id' found
```

Exit `2`. `codex exec --session-id` de yok; birinci taraf issue [#15271](https://github.com/openai/codex/issues/15271) tam da bunu istiyor ve açık.

Açık UUID vermek `codex resume <SESSION_ID>` ile **devam ettirme**dir, yeni oturuma id atamak değil.

### 2.2 Yakalama

Resmi kanca sözleşmesi her komut kancasına `session_id` ve `transcript_path` verir ([Hooks](https://learn.chatgpt.com/docs/hooks) / [developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks/)). `SessionStart` `source`: `startup` \| `resume` \| `clear` \| `compact`.

**Ölçüm (etkileşimli PTY, `CODEX_HOME` izole, `~/.codex/hooks.json` `SessionStart`, `--dangerously-bypass-hook-trust`):** kanca şunu yazdı:

```json
{
  "session_id": "01a094d0-fecd-70f1-923e-fcb7d66ca4df",
  "transcript_path": "/tmp/pty-sid-research/codex-home2/sessions/2026/09/12/rollout-2026-09-12T11-51-59-01a094d0-fecd-70f1-923e-fcb7d66ca4df.jsonl",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "gpt-6-astra"
}
```

Aynı rollout dosyası diskte vardı; ilk satır `session_meta.payload.session_id` = aynı UUID, `originator: "codex-tui"`, `source: "cli"`. Kullanıcı promptu gönderilmeden oluştu.

**Dikkatler:**

- Codex kancaları varsayılan olarak güven incelemesi ister (`/hooks`). İncelenmemiş kanca atlanır. Otomasyonda `--dangerously-bypass-hook-trust` veya önceden güvenilmiş kanca tanımı gerekir.
- Rollout, TUI `ThreadStarted` almadan önce henüz yok olabilir ([commit](https://github.com/openai/codex/commit/bf2aee99c58362d3f588d98432dcbc7adc371c73)). "En yeni dosyayı izle" kancadan daha geç ve yarışlıdır; kancanın verdiği `transcript_path` birincil yoldur.
- `threads` sqlite tablosu bu kısa TUI koşusunda boş kaldı; id'yi oradan okumak güvenilir değil.

### 2.3 PTY stdout / OSC

Varsayılan TUI başlığı session id taşımaz.

**Ölçüm (varsayılan, `--no-alt-screen`):** OSC 0 sırası `codex-work`, `⠋ codex-work`, `⠙ codex-work`, … — proje klasörü + spinner. UUID yok.

Başlık yapılandırılabilir: `tui.terminal_title` öğeleri arasında `session-id` / `thread-id` var; açıklama "Current thread identifier (omitted until thread starts)" ([title_setup.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/title_setup.rs)).

**Ölçüm:** `codex -c 'tui.terminal_title=["session-id"]'` etkileşimli PTY'de OSC'ye `01a094d0-fecd-70f1-923e-fcb7d...` yazdı (32 karakter, ellipsis). Tam UUID 36 karakterdir; OSC **kısaltır**. `set_terminal_title` tavanı 240 karakterdir ([terminal_title.rs](https://github.com/openai/codex/blob/main/codex-rs/tui/src/terminal_title.rs)); 32 karakterlik kısaltma öğe formatından gelir. Tam UUID kancada ve rollout dosya adında durur.

TUI kapanırken (ölçüm, `--no-alt-screen`):

```
Session ID: 01a094cc-cca2-7a30-ad84-34cd77a600a4
```

Bu satır **çıkış anı**dır, canlı oturum için değil; PTY stdout kazımasıdır. AgentDeck süreci yaşarken bu yola bel bağlanmamalı.

`codex exec` insan başlığındaki `session id:` satırı headless'tır; etkileşimli TUI'nin karşılığı değildir.

### 2.4 Çakışma

Dayatma olmadığı için "dayatılan id zaten var" senaryosu yok. Var olmayan id ile resume [#10](https://github.com/osmntahir/agentdeck/issues/10)'da ölçüldü: `no rollout found for thread id`, exit `1`.

---

## 3. Google Gemini CLI (`gemini` 0.59.0)

### 3.1 Dayatma

`--session-id` etkileşimli varsayılanın bayrağıdır (`-p` zorunlu değil).

> `--session-id` — "Start a new session with a manually provided UUID."
> — `gemini --help`

Kaynak: [`packages/cli/src/config/config.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts) ve [`packages/cli/src/gemini.tsx` `resolveSessionId`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/gemini.tsx).

- `--resume`, `--session-id`, `--session-file` **karşılıklı dışlanır**.
- Coerce: boş olamaz; `^[a-zA-Z0-9-_]+$` (UUID zorunlu değil, `--help` metni dar).
- `sessionIdArg` varsa ve `sessionExists` true ise süreç `FATAL_INPUT_ERROR` (42) ile çıkar; aksi halde `{ sessionId: sessionIdArg }` döner. Bu, `refreshAuth`'tan **önce** çalışır.

**Ölçüm (ayrıştırma):**

| Komut | Sonuç | Çıkış |
| --- | --- | --- |
| `gemini --session-id 'bad id!'` | `Invalid session ID "bad id!": Only alphanumeric characters, dashes, and underscores are allowed.` | `1` |
| `gemini --session-id ''` | `The --session-id option cannot be empty.` | `1` |
| `gemini --session-id <uuid> --resume latest` | `The flags --resume, --session-id, and --session-file are mutually exclusive.` | `1` |

**Ölçüm (etkileşimli PTY, `GEMINI_CLI_HOME` izole, auth `IneligibleTierError`):** `gemini --session-id 084987d3-0d8c-406f-acdf-67245e52f8d3 --skip-trust -y`

- TUI açıldı (auth seçici; model çağrısı yok).
- Dosya: `$GEMINI_CLI_HOME/.gemini/tmp/gemini-work/chats/session-2026-09-12T08-52-084987d3.jsonl`
- İlk satır `"sessionId":"084987d3-0d8c-406f-acdf-67245e52f8d3"`.
- `SessionStart` kancası aynı id'yi verdi; ortamda `GEMINI_SESSION_ID` set.

Dayatma, kimlik doğrulama başarısından bağımsızdır.

### 3.2 Yakalama

Kanca sözleşmesi her olaya `session_id` ve `transcript_path` verir; ortamda `GEMINI_SESSION_ID` vardır ([hooks/index.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md), [hooks/reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md)).

**Ölçüm:** `SessionStart` / `source: "startup"`, auth başarısızken:

```json
{
  "session_id": "084987d3-0d8c-406f-acdf-67245e52f8d3",
  "transcript_path": "…/chats/session-2026-09-12T08-52-084987d3.jsonl",
  "hook_event_name": "SessionStart",
  "source": "startup"
}
```

Dosya izleme: `~/.gemini/tmp/<proje>/chats/session-<ts>-<8-önek>.jsonl` (0.59.0'da JSONL). Ad öneki UUID'nin ilk 8 karakteridir; tam id ilk satırdaki `sessionId`.

`gemini --list-sessions` aynı cwd'den **ayrı bir süreç** olarak yan kanaldır, PTY scrape değildir. [#10](https://github.com/osmntahir/agentdeck/issues/10) gerçek kullanıcı evinde tam UUID listesi verdi. Bu araştırmada izole ev + `IneligibleTierError` altında yeni yazılmış jsonl `No previous sessions found for this project.` (exit `0`, stderr'de auth hatası) döndü. Yani list-sessions, yeni/boş oturum için anlık yakalama olarak güvenilir değil; kanca ve dosya daha erken.

### 3.3 PTY stdout kazıması

Önerilmez. OSC başlığı `"◇ Ready (gemini-work)"` — UUID yok. TUI gövdesinde UUID yok (**ölçüm**).

### 3.4 Çakışma

`SessionSelector.sessionExists`: `chats/` altında `session-*` ve `-<id'nin ilk 8 karakteri>.json` / `.jsonl`, sonra kayıttaki `sessionId === id` (kurulu 0.59.0 bundle; `packages/cli/src/utils/sessionUtils.ts`, [issue #27282](https://github.com/google-gemini/gemini-cli/issues/27282) aynı `sessionExists` yolunu alıntılıyor).

**Ölçüm:**

1. Ekilmiş `.json` (`sessionId` alanı uyan): PTY `Error starting session: Session ID "930df64d-…" already exists. Use --resume to resume it, or provide a different ID.`, exit `42`.
2. TUI'nin yazdığı `.jsonl` dururken aynı `--session-id`: aynı hata, PTY (süreç hemen çıktı).

Üzerine yazma yok; resume yok. Devam ettirmek `--resume <uuid>` ister.

---

## 4. AgentDeck için sonuçlar

**1. Claude ve Gemini'de kimliği spawn anında dayatmak mümkün ve etkileşimli TUI'de geçerli.** Bugünkü `exec claude` / `exec gemini` (`src/server/sessions.ts`) bayraksız. `exec claude --session-id <uuid>` ve `exec gemini --session-id <uuid>` PTY TUI'yi bozmaz. UUID'yi AgentDeck `Session` kaydına yazmak (şu an alan yok) restart=`resume` için sağlam tabandır. Codex'te karşılık yok; id sonradan yakalanır.

**2. Dayatılan id resume değildir.** Aynı UUID ile yeniden ` --session-id` Claude'da exit `1` (`already in use`), Gemini'de exit `42` (`already exists`). Süreç ölmüş, transcript duruyor olsa bile. Yeniden başlat = aynı ajan konuşması ise komut `--resume` / `codex resume <id>` / `gemini --resume <id>` olmalıdır — [#4](https://github.com/osmntahir/agentdeck/issues/4) ve [#10](https://github.com/osmntahir/agentdeck/issues/10) ile doğrudan bağ.

**3. Scrape'siz yakalama üçünde de kanca ile mümkün.** `SessionStart` stdin'inde `session_id` (+ Claude/Gemini/Codex'te `transcript_path`). AgentDeck bunu worktree içi proje ayarıyla (`<cwd>/.claude/settings.json`, `<cwd>/.codex/hooks.json`, `<cwd>/.gemini/settings.json`) veya kullanıcının ev ayarına dokunmadan izole kanca dosyasıyla alabilir. Kanca, PTY stdout'undan bağımsız bir yan süreçtir.

Codex kancası güven incelemesi ister; inceleme yapılmazsa sessizce atlanır. Otomasyonda `--dangerously-bypass-hook-trust` veya önceden hash'lenmiş güven kaydı gerekir.

**4. Dosya izleme kancanın yedeğidir, birincil yol değil.** Claude'da dosya adı = UUID ve oturum başında yazılır. Gemini'de ad yalnızca 8 karakter önek + tam id dosya içinde. Codex'te `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` TUI başladıktan kısa süre sonra oluşur ama `ThreadStarted` ile yarışabilir. "En yeni dosya" birden fazla paralel oturumda yanlış id verir.

**5. OSC başlığı Codex dışında kimlik taşımaz; Codex'te de varsayılan olarak taşımaz.** Claude `"✳ Claude Code"`, Gemini `"◇ Ready (<proje>)"`. Codex varsayılanı spinner + proje klasörü. `tui.terminal_title=["session-id"]` (veya `codex -c '…'`) kısaltılmış UUID basar — tam id değil, yapılandırma gerektirir, scrape'e yakındır. Birincil yol olmamalı.

**6. `gemini --list-sessions` canlı TUI'nin yerine geçmez.** Aynı cwd'den ayrı süreç olarak yan kanal olabilir (PTY scrape değil) ama auth'a bağlıdır ve bu makinede yeni jsonl'i listelemedi. Dayatma veya `SessionStart` tercih edilmeli.

**7. Güven diyalogları kimlikten ayrı, ama kancayı geciktirebilir.** Yeni cwd'de Claude workspace trust / bypass onayı, Codex dizin güveni TUI'yi durdurur. `--dangerously-skip-permissions` Claude trust diyalogunu atlamaz (**ölçüm**). AgentDeck worktree'leri yeni mutlak yol olduğu için bu, kimlik kancasının ateşlenmesinden önce bir kapıdır.

---

## 5. Açık kalanlar / doğrulanamayanlar

1. **Claude `--session-id` + `--resume` + `--fork-session`:** ikili dizgede var, PTY'de ölçülmedi. Çakışmayı fork'a çevirip çevirmediği bilinmiyor.
2. **Aynı UUID ile iki canlı Claude süreci:** çakışma, birinci çıktıktan sonra ölçüldü. İkisi birden açıkken davranış (dokümanın "iki terminalde resume transcript'i karıştırır" notu) ayrıca bakılmadı.
3. **Codex `SessionStart` kancası, `--dangerously-bypass-hook-trust` olmadan:** güven UI'si TUI'yi böler; AgentDeck'in kancayı önceden trust edip edemeyeceği ölçülmedi.
4. **Codex OSC `session-id` öğesinin 32 karakterlik ellipsis'i:** ölçüldü; title renderer'daki tam format fonksiyonu bu araştırmada satır satır bağlanmadı. Tam UUID kanca/rollout'ta duruyor.
5. **Codex rollout'un kanca anındaki varlığı:** kanca `transcript_path` verdi ve dosya sonradan görüldü; kanca ateşlendiği milisaniyede dosyanın bitmiş olup olmadığı ölçülmedi.
6. **Gemini `--list-sessions` yeni/boş jsonl'i neden atladı:** auth hatası, "mesajsız oturum" filtresi veya izole ev. Kullanıcı evinde dolu oturumlar [#10](https://github.com/osmntahir/agentdeck/issues/10)'da listeleniyordu. `--session-id` / `--resume` varlık tanımlarının ayrıştığı de bilinıyor ([gemini-cli#27282](https://github.com/google-gemini/gemini-cli/issues/27282)): `sessionExists` dosyayı görür, `listSessions` metadata-only kayıtları düşürebilir.
7. **Gemini `--session-id` UUID olmayan `[A-Za-z0-9-_]+` değerle TUI'nin dosya adı/çakışma davranışı:** ayrıştırma kabul eder; tam TUI yolu yalnızca UUID ile ölçüldü.
8. **Gemini kanca güven parmak izi diyaloğu:** proje kancası bu koşuda `SessionStart`'ı ateşledi; parmak izi uyarısının her ortamda kancayı kesip kesmediği ölçülmedi.

---

## 6. Kaynaklar

**Claude Code**

- https://code.claude.com/docs/en/cli-reference (`--session-id`)
- https://code.claude.com/docs/en/sessions (transcript yolu, `--resume` ≠ `--session-id`, kanca/`transcript_path`)
- https://code.claude.com/docs/en/hooks#common-input-fields (`session_id`, `transcript_path`)
- https://code.claude.com/docs/en/statusline#available-data (`session_id`, `transcript_path`)
- `claude --help` (2.1.269)
- Yerel ikili dizgeler: `Error: Invalid session ID. Must be a valid UUID.`; `Error: Session ID ${id} is already in use.`; `--session-id can only be used with --continue or --resume if --fork-session is also specified.`
- Ölçüm: izole `CLAUDE_CONFIG_DIR` PTY, `SessionStart` kancası, transcript JSONL, çakışma, `claude -p --resume` yan kanalı

**OpenAI Codex CLI**

- `codex --help`, `codex resume --help` (0.154.0)
- https://github.com/openai/codex/blob/main/codex-rs/tui/src/cli.rs (`resume_session_id` clap skip)
- https://github.com/openai/codex/issues/15271 (`--session-id` yok)
- https://learn.chatgpt.com/docs/hooks (`session_id`, `transcript_path`, `SessionStart`)
- https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/title_setup.rs (`TerminalTitleItem::SessionId`)
- https://github.com/openai/codex/blob/main/codex-rs/tui/src/terminal_title.rs (OSC 0 + BEL)
- Ölçüm: `codex --session-id` exit `2`; varsayılan OSC; `-c 'tui.terminal_title=["session-id"]'` kısaltılmış OSC; `SessionStart` kancası + rollout JSONL; çıkış satırı `Session ID:`

**Google Gemini CLI**

- `gemini --help` (0.59.0)
- https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts (`--session-id` coerce, karşılıklı dışlama)
- https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/gemini.tsx (`resolveSessionId`, çakışma mesajı, auth'tan önce)
- Kurulu 0.59.0 `bundle/` içindeki `sessionExists` (chats/session-*-<8>.json(l) + `sessionId`); https://github.com/google-gemini/gemini-cli/issues/27282 aynı yolu alıntılıyor
- https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/utils/sessionUtils.ts
- https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/index.md (`GEMINI_SESSION_ID`)
- https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md (base input `session_id`, `transcript_path`)
- Ölçüm: geçersiz karakter exit `1`; PTY dayatma + jsonl; `SessionStart` kancası (auth hatasına rağmen); çakışma exit `42`; OSC'de id yok; `IneligibleTierError` sınırı
