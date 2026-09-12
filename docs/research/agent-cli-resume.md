# Ajan CLI'larında oturum devam ettirme (resume) mekanizmaları

> Tarihli araştırma kanıtı: aşağıdaki ölçümler o sürüm/ortama aittir. Güncel ürün politikası [spec revizyon 2](../specs/agentdeck-v0.md) ve [karar uzlaştırması](../reviews/2026-09-12-decision-reconciliation.md) içindedir. Buradaki öneriler yeni launch/preview sözleşmesini geçersiz kılmaz.

**Kapsam:** `claude`, `codex` ve `gemini` komut satırı araçlarının önceki bir oturumu devam ettirme mekanizmalarının; komut biçimi, oturum kimliği, çalışma dizini bağımlılığı, etkileşimsiz kullanım ve "oturum yok" davranışı açısından karşılaştırılması.

**Araştırma tarihi:** 2026-09-12

**Kontrol edilen sürümler** (hepsi bu makinede kurulu, `--help` çıktıları birincil kaynak olarak kullanıldı):

| CLI | Sürüm | Yol |
| --- | --- | --- |
| Claude Code | `2.1.269` (`claude --version`) | `/home/codexist/.local/bin/claude` |
| OpenAI Codex CLI | `codex-cli 0.154.0` (`codex --version`) | `/home/codexist/.nvm/versions/node/v22.19.0/bin/codex` |
| Google Gemini CLI | `0.59.0` (`gemini --version`) | `/home/codexist/.nvm/versions/node/v22.19.0/bin/gemini` |

**Yöntem notu:** Doküman iddialarına ek olarak, kritik olan 3. başlık (cwd bağımlılığı) ve 5. başlık (oturum yoksa davranış) için bu makinede kontrollü deneyler yapıldı. Deneylerde scratchpad altında üç boş dizin (`dirA`, `dirB`, `dirC`) kullanıldı. Deney sonuçları aşağıda "**ölçüm**" olarak işaretlendi. Gemini CLI bu makinede kimlik doğrulamadan geçemediği için (`IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`) Gemini tarafında yalnızca model çağrısı gerektirmeyen adımlar ölçülebildi; bu sınır ilgili yerlerde belirtildi.

---

## 1. Claude Code (`claude` 2.1.269)

### 1.1 Komut biçimi

Mekanizma **bayrak** tabanlıdır; ayrı bir `resume` alt komutu yoktur.

| Komut | Anlamı | Kaynak |
| --- | --- | --- |
| `claude -c` / `claude --continue` | "Continue the most recent conversation in the current directory" | `claude --help` |
| `claude --resume` (değersiz) | Etkileşimli oturum seçici (picker) açar | `claude --help`, [sessions](https://code.claude.com/docs/en/sessions) |
| `claude -r <session-id>` / `claude --resume <session-id>` | Belirli oturumu id ile devam ettirir | [cli-reference](https://code.claude.com/docs/en/cli-reference) |
| `claude --resume <name>` | Oturumu adıyla devam ettirir | [sessions](https://code.claude.com/docs/en/sessions) |
| `claude --resume <transcript-path>` | `.jsonl` transcript dosyasının **mutlak yolu** ile devam ettirir | [sessions](https://code.claude.com/docs/en/sessions) |
| `claude --from-pr <number>` | Bir PR'a bağlı oturumları filtreleyerek seçici açar | `claude --help` |
| `--fork-session` | `--resume` / `--continue` ile birlikte: orijinali korur, yeni bir oturum id'si üretir | `claude --help` |
| `--session-id <uuid>` | Devam ettirme değil; **yeni** oturuma belirli bir UUID atar | `claude --help` |
| `/resume`, `/branch` | Oturum içinden başka bir konuşmaya geçiş / dallanma | [sessions](https://code.claude.com/docs/en/sessions) |

**Varyantlar arasındaki fark:** `--continue` "bulunduğun dizindeki en son konuşma"yı açar ve seçicisizdir; `--resume <id>` ise belirli bir oturumu hedefler. Ayrıca `--continue` varsayılan olarak bazı oturumları **atlar**:

> "Skips sessions created with `claude -p` or the Agent SDK, and sessions whose first prompt was `/loop`. `claude -p --continue` includes `-p`, SDK, and `/loop` sessions."
> — [cli-reference](https://code.claude.com/docs/en/cli-reference)

Yani `-p` ile oluşturulmuş bir oturum düz `claude --continue` ile açılmaz; ya `claude -p --continue` kullanılmalı ya da id ile `--resume` yapılmalıdır ([sessions](https://code.claude.com/docs/en/sessions)).

### 1.2 Oturum kimliği

**Nereden alınır:**

- `claude -p --output-format json` çıktısındaki `session_id` alanı. **Ölçüm:** `claude -p "Reply with exactly: OK" --output-format json` çıktısı `{"...","session_id":"de60992d-db9f-4d31-b6e2-dc7d3024c0dd",...}` şeklindedir.
- Etkileşimli seçici (`claude --resume`), `/resume`.
- Hook'ların ve statusline komutlarının aldığı `transcript_path` alanı ([sessions](https://code.claude.com/docs/en/sessions)).

**Nerede saklanır:**

> "By default, Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric characters replaced by `-`. For a working directory whose converted name exceeds 200 characters, Claude Code truncates the name to 200 characters and appends a hash of the full path..."
> — [sessions](https://code.claude.com/docs/en/sessions)

**Ölçüm:** `dirA` içinde başlatılan oturum şuraya yazıldı:
`~/.claude/projects/-tmp-claude-1000--home-codexist-Desktop-agentdeck-be4ef843-a435-4322-8ab3-a487aa54b01d-scratchpad-dirA/de60992d-db9f-4d31-b6e2-dc7d3024c0dd.jsonl`

Dosya biçimi JSONL'dir; her satır bir mesaj/araç kullanımı/metadata kaydıdır ve satırlarda `sessionId`, `cwd`, `version`, `gitBranch` alanları bulunur (ölçüm). Doküman bu biçimin **iç kullanıma ait** olduğunu ve sürümler arasında değişebileceğini açıkça belirtiyor; doğrudan ayrıştırma önerilmiyor ([sessions](https://code.claude.com/docs/en/sessions)).

Konum yapılandırılabilir: `CLAUDE_CONFIG_DIR` (kök dizin), `CLAUDE_CODE_PROJECT_DIR_NAME` (proje klasörü adı, v2.1.234+), `cleanupPeriodDays` (varsayılan 30 gün saklama) ([sessions](https://code.claude.com/docs/en/sessions)).

### 1.3 cwd / dizin bağımlılığı

**Net cevap: `--resume <session-id>` dizinden bağımsızdır, `--continue` değildir.**

> "You can run `claude --resume <session-id>` from any directory: Claude Code looks for the ID in the current project directory and its git worktrees first, then in every other project on this machine, so it finds a session that started elsewhere or moved with `/cd`. The cross-project search resolves the ID only when exactly one other project holds a transcript with messages for it... Before v2.1.223, the lookup stopped at the current project directory and its git worktrees, so you had to resume from the directory the session last worked in."
> — [sessions](https://code.claude.com/docs/en/sessions)

Kurulu sürüm 2.1.269 > 2.1.223 olduğundan makine geneli arama etkindir.

**Ölçüm (kritik):** `dirA` içinde `-p` ile başlatılan `de60992d-...` oturumu, **farklı bir dizinden** (`dirB`) `claude -p --resume de60992d-... "Reply with exactly: OK2"` ile başarıyla devam ettirildi. Çıkış kodu `0`, dönen `session_id` **aynı** kaldı (`de60992d-...`), yanıt `OK2`. Ayrıca transcript dosyası **orijinal** proje klasöründe (`...-dirA`) kaldı; `dirB` proje klasöründe yalnızca boş bir `memory` alt dizini oluştu.

Diğer dizin kapsamı kuralları:

- `--continue`: yalnızca **bulunulan dizin** ("the current directory"), artı `/add-dir` ile bu dizini eklemiş oturumlar (`claude --help`, [cli-reference](https://code.claude.com/docs/en/cli-reference)).
- Seçici varsayılanı: **mevcut worktree**. `Ctrl+W` deponun tüm worktree'lerine, `Ctrl+A` makinedeki tüm projelere genişletir ([sessions](https://code.claude.com/docs/en/sessions)).
- Adla devam ettirme: "Resuming by name resolves across the current repository and its worktrees" — yani ad çözümlemesi depo + worktree'leri kapsar, makine geneli değildir ([sessions](https://code.claude.com/docs/en/sessions)).
- Seçiciden başka bir worktree'nin oturumu seçilirse yerinde devam eder; **ilgisiz** bir projenin oturumu seçilirse Claude Code devam ettirmek yerine panoya bir `cd` + resume komutu kopyalar ([sessions](https://code.claude.com/docs/en/sessions)).

**Worktree açısından sonuç:** Farklı bir git worktree'si ayrı bir proje klasörüne yazılır (ölçüm: `~/.claude/projects/` altında `-home-codexist-Desktop-winvestate-vakifbank--claude-worktrees-fix-...` gibi ayrı dizinler mevcut), ancak `--resume <id>` worktree sınırını aşar — hem "current project directory and its git worktrees" adımında hem de makine geneli aramada bulunur.

### 1.4 Etkileşimsiz / programatik başlatma

Destekleniyor ve dokümanda açıkça örnekleniyor:

```bash
claude -p --resume <session-id> --output-format json "summarize what we changed" | jq -r '.result'
```
— [sessions](https://code.claude.com/docs/en/sessions)

| Kombinasyon | Durum | Kaynak |
| --- | --- | --- |
| `claude -p --resume <id> "prompt"` | Destekleniyor (**ölçüldü**, çıkış kodu 0) | [sessions](https://code.claude.com/docs/en/sessions) |
| `claude -c -p "query"` | Destekleniyor ("Continue via SDK") | [cli-reference](https://code.claude.com/docs/en/cli-reference) |
| `--output-format text\|json\|stream-json` | Yalnızca `--print` ile | `claude --help` |
| `--fork-session` | `--resume`/`--continue` ile | `claude --help` |
| `--no-session-persistence` | Yalnızca `--print` ile; oturum diske yazılmaz ve **devam ettirilemez** | `claude --help` |
| `--bg` + `--resume <session-id>` | Oturumu aynı id altında arka planda sürdürür; oturum zaten çalışıyorsa kopya başlatıp bunu bildirir | `claude --help` |

İzin modu uyarısı: `claude -p --resume` / `claude -p --continue` çalıştırmaları, oturumun kayıtlı izin modunu geri yüklemez; yeni bir `claude -p` çalıştırmasının başlayacağı modda başlar (plan modu için dört koşullu istisna hariç) ([sessions](https://code.claude.com/docs/en/sessions)).

Ayrıca `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model` ve `--add-dir` gibi bayraklar resume sırasında geri yüklenmez; tekrar geçilmeleri gerekir ([sessions](https://code.claude.com/docs/en/sessions)).

### 1.5 Devam ettirilecek oturum yoksa

| Senaryo | Davranış | Çıkış kodu | Kaynak |
| --- | --- | --- | --- |
| `claude -p --continue`, dizinde hiç oturum yok | **Sessizce yeni oturum açar**, prompt normal çalışır | `0` | **Ölçüm** (`dirC`) |
| `claude -p --resume <bilinmeyen-uuid>` | `No conversation found with session ID: <session-id>` | `1` | **Ölçüm** + [sessions](https://code.claude.com/docs/en/sessions) |
| Seçiciden seçilen oturum yüklenemezse | `Failed to resume the conversation` yazar ve çıkar | `1` | [sessions](https://code.claude.com/docs/en/sessions) |
| `--continue` ve en son konuşma hâlâ arka planda çalışıyorsa | `Your most recent conversation is running in the background` + oturum id'si yazıp çıkar | doğrulanamadı | [sessions](https://code.claude.com/docs/en/sessions) |

---

## 2. OpenAI Codex CLI (`codex` 0.154.0)

### 2.1 Komut biçimi

Mekanizma **alt komut** tabanlıdır.

| Komut | Anlamı | Kaynak |
| --- | --- | --- |
| `codex resume` | Etkileşimli seçici (varsayılan) | `codex resume --help` |
| `codex resume --last [PROMPT]` | Seçici göstermeden en son oturumu sürdürür | `codex resume --help` |
| `codex resume <SESSION_ID> [PROMPT]` | Belirli oturum. Argüman "Session id (UUID) or session name. UUIDs take precedence if it parses." | `codex resume --help` |
| `codex resume --all` | "Show all sessions (disables cwd filtering and shows CWD column)" | `codex resume --help` |
| `codex resume --include-non-interactive` | Etkileşimsiz oturumları da seçiciye ve `--last` seçimine dâhil eder | `codex resume --help` |
| `codex exec resume <SESSION_ID> [PROMPT]` | Etkileşimsiz devam ettirme | `codex exec resume --help` |
| `codex exec resume --last [PROMPT]` | Etkileşimsiz, en son oturum | `codex exec resume --help` |
| `codex exec resume --all` | "Show all sessions (disables cwd filtering)" | `codex exec resume --help` |
| `codex fork [SESSION_ID]` / `codex fork --last` | Oturumu **yeni bir oturuma** çatallar | `codex fork --help` |
| `codex exec fork <SESSION_ID> [PROMPT]` | Etkileşimsiz çatallama | `codex exec fork --help` |

İlgili yardımcı alt komutlar: `codex agents` ("Browse all agent sessions on the shared local app-server daemon"), `codex queue`, `codex archive`, `codex unarchive`, `codex delete`, `codex migrate-rollouts` (`codex --help`).

**Varyantlar arasındaki fark:** `resume` orijinal oturum id'sini **korur** (ölçüm ile doğrulandı), `fork` ise yeni bir oturum üretir. `--last` seçiciyi atlayıp en son oturumu alır; `<SESSION_ID>` ise doğrudan hedefler.

### 2.2 Oturum kimliği

**Nereden alınır:**

- `codex exec --json` çıktısının ilk olayı:
  ```json
  {"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
  ```
  — [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) (`docs/exec.md` bu sayfaya yönlendiriyor). **Ölçüm:** `codex exec --json` çıktısında ilk satır `{"type":"thread.started","thread_id":"01a094a7-7541-76d3-8704-bf1cf3b5d6cf"}` olarak gözlendi.
- `codex exec`'in insan okunur başlığı `session id: <uuid>` satırını basar (**ölçüm**).
- Etkileşimli seçici (`codex resume`, `codex resume --all`). **Salt metin döken bir `list` alt komutu `codex --help` çıktısında yoktur** — listeleme TUI seçicisi veya `codex agents` üzerinden yapılır.

**Nerede saklanır (ölçüm):**

```
$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO8601>-<session_id>.jsonl
```

Örnek: `~/.codex/sessions/2026/09/12/rollout-2026-09-12T11-06-37-01a094a7-7541-76d3-8704-bf1cf3b5d6cf.jsonl`

Dosya JSONL'dir ve ilk satır bir `session_meta` kaydıdır:

```json
{"timestamp":"...","ordinal":0,"type":"session_meta","payload":{"session_id":"...","id":"...","timestamp":"...","cwd":"/home/codexist/Desktop/kiosk","originator":"Codex Desktop","cli_version":"0.153.1","source":"vscode","model_provider":"openai","base_instructions":{...}}}
```

Yani **çalışma dizini oturum dosyasının içine yazılır** — cwd filtrelemesinin dayanağı budur. Arşivlenen oturumlar `~/.codex/archived_sessions/` altına taşınır (ölçüm: dizin mevcut).

`codex exec --ephemeral` ile oturum diske hiç yazılmaz ("Run without persisting session files to disk", `codex exec --help`).

> Not: `docs/config.md` içinde `~/.codex/sessions` yoluna dair bir bölüm bulunamadı; yukarıdaki yol **yalnızca yerel gözleme** ve `--help` metinlerine dayanıyor, resmî dokümanda doğrulanamadı.

### 2.3 cwd / dizin bağımlılığı

**Net cevap: Seçici ve `--last` varsayılan olarak cwd'ye göre filtrelenir; açık `<SESSION_ID>` ile devam ettirme filtrelenmez.**

`--help` metni bunu doğrudan söylüyor:

> `--all` — "Show all sessions (disables cwd filtering and shows CWD column)."
> — `codex resume --help` (kaynakta `codex-rs/cli/src/main.rs`)

Üç ölçüm bunu kesinleştirdi:

1. **Açık id ile, farklı dizinden:** `dirA`'da başlatılan `01a094a7-...` oturumu, `dirB` içinden `codex exec resume 01a094a7-... "Reply with exactly: OK2"` ile **başarıyla** devam etti. Çıkış kodu `0`, başlıkta `session id: 01a094a7-...` (aynı id) ve `workdir: .../dirB` (yeni dizin). → **Açık id, dizin sınırını aşar.**
2. **`--last`, oturumu olan dizinde:** `dirB` içinde `codex exec resume --last` çalıştırıldığında `01a094a7-...` oturumu bulundu.
3. **`--last`, oturumu olmayan taze dizinde:** `dirC` içinde `codex exec resume --last` hiçbir şey bulmadı ve yeni bir oturum açtı; aynı `dirC` içinde `codex exec resume --last --all` çalıştırıldığında ise başka dizine ait `01a094a7-...` oturumu bulundu. → **Farkı yaratan tek şey cwd filtrelemesidir.**

**Rollout dosyasındaki cwd kaydı (ölçüm):** `session_meta.cwd` oturumun **ilk başlatıldığı** dizini tutar ve değişmez; her resume işlemi dosyaya o çalıştırmanın cwd'siyle yeni bir `turn_context` kaydı ekler. Yukarıdaki oturumun dosyasında `session_meta` → `dirA`, ardından sırasıyla `dirA`, `dirB`, `dirB`, `dirC` `turn_context` kayıtları bulundu. `--last` filtresinin tam olarak hangi alana baktığı (`session_meta.cwd` mi, en son `turn_context.cwd` mi) kaynak koddan **doğrulanmadı**; ancak `dirA`'da başlayıp `dirB`'de resume edilen oturumun `dirB`'de `--last` ile bulunması, filtrenin yalnızca ilk `session_meta.cwd`'ye bakmadığını gösteriyor.

**Worktree açısından sonuç:** Farklı bir worktree farklı bir cwd demektir; `codex resume`/`codex exec resume --last` o worktree'de diğer worktree'nin oturumlarını **görmez**. Görmesi için ya `--all` eklenmeli ya da oturum id'si açıkça verilmelidir.

### 2.4 Etkileşimsiz / programatik başlatma

`codex exec` zaten headless moddur ve `resume` onun alt komutudur — doküman doğrudan bu kalıbı veriyor:

```bash
codex exec "review the change for race conditions"
codex exec resume --last "fix the race conditions you found"
codex exec resume <SESSION_ID>
```
— [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

`codex exec resume` üzerinde kullanılabilen ilgili bayraklar (`codex exec resume --help`): `--json` (JSONL olay akışı), `-o/--output-last-message <FILE>`, `--output-schema <FILE>`, `--skip-git-repo-check`, `--ephemeral`, `-m/--model`, `-i/--image`, `--worktree`, `--add-dir`, `--all`, `--last`, `--dangerously-bypass-approvals-and-sandbox`.

**Önemli tuzak (ölçüm):** `codex exec resume`, üst komut `codex exec`'in aksine `-s/--sandbox`, `-a/--ask-for-approval` ve `-C/--cd` bayraklarını **kabul etmez**. Denendiğinde:

```
error: unexpected argument '--sandbox' found
Usage: codex exec resume --skip-git-repo-check <SESSION_ID> [PROMPT]
```

Sandbox/onay politikası devam ettirilen oturumdan ve yapılandırmadan gelir (ölçüm çıktısında `sandbox: read-only`, `approval: never` olarak göründü). `--dangerously-bypass-approvals-and-sandbox` ise kabul edilir.

Etkileşimli `codex resume` (TUI) ise PTY gerektirir; bu araştırmada TUI yolu test edilmedi.

### 2.5 Devam ettirilecek oturum yoksa

| Senaryo | Davranış | Çıkış kodu | Kaynak |
| --- | --- | --- | --- |
| `codex exec resume --last`, cwd'de eşleşen oturum yok | **Sessizce yeni oturum açar** (yeni bir session id üretir), prompt normal çalışır | `0` | **Ölçüm** (`dirC`) |
| `codex exec resume <bilinmeyen-uuid>` | `Error: thread/resume: thread/resume failed: no rollout found for thread id <uuid> (code -32600)` | `1` | **Ölçüm** |

Bu asimetri agentdeck açısından önemlidir: `--last` başarısızlığı **sessizdir** ve yanlışlıkla temiz bir oturum başlatır; yalnızca açık id verildiğinde hata alınır.

---

## 3. Google Gemini CLI (`gemini` 0.59.0)

### 3.1 Komut biçimi

Mekanizma **bayrak** tabanlıdır; ayrı bir `resume` alt komutu yoktur.

| Komut | Anlamı | Kaynak |
| --- | --- | --- |
| `gemini --resume` (değersiz) | "This immediately loads the most recent session." | [session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md) |
| `gemini -r "latest"` | En son oturum | [cli-reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md) |
| `gemini --resume 1` / `-r <index>` | Listedeki sıra numarasıyla | [session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md) |
| `gemini --resume <uuid>` | Tam oturum UUID'si ile | [session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md) |
| `gemini -r "latest" "query"` | Devam ettir + yeni prompt | [cli-reference.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md) |
| `gemini --list-sessions` | "List available sessions for the current project and exit" | `gemini --help` |
| `gemini --delete-session <index\|id>` | Oturum siler | `gemini --help` |
| `gemini --session-file <path>` | "Load a session from a JSON file" | `gemini --help` |
| `gemini --session-id <uuid>` | Devam ettirme değil; **yeni** oturuma verilen UUID'yi atar | `gemini --help` |
| `/resume` (oturum içi) | Session Browser'ı açar (ara, önizle, `x` ile sil) | [session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md) |
| `/resume save <ad>` / `/resume list` / `/resume resume <ad>` | Adlandırılmış checkpoint'ler (`/chat ...` eşanlamlı) | [session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md) |

`--resume`, `--session-id` ve `--session-file` **birbirini dışlar**; birden fazlası verilirse `The flags --resume, --session-id, and --session-file are mutually exclusive. Please provide only one.` hatası döner (kaynak kod: [`packages/cli/src/config/config.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts)).

**Doküman/`--help` tutarsızlığı:** Kurulu 0.59.0'ın `--help` çıktısı `--resume` için yalnızca `Use "latest" for most recent or index number (e.g. --resume 5)` diyor ve UUID'den söz etmiyor; buna karşılık `docs/cli/session-management.md` hem değersiz `--resume` hem de tam UUID kullanımını belgeliyor. UUID kabul edildiği ölçümle doğrulandı (aşağıya bakınız). Değersiz `--resume` kullanımı doğrulanmadı.

### 3.2 Oturum kimliği

**Nereden alınır:**

- `gemini --list-sessions`. **Ölçüm** (`/home/codexist/Desktop/winvestate-next` içinde):
  ```
  Available sessions for this project (52):
    1. Replace DTOs and refactor geography service. (183 days ago) [b74f1df7-462c-4a92-bfc2-b01d3749385c]
    2. Projedeki ilişkileri kontrol et ve düzelt. (183 days ago) [3b30a25a-a6e8-4aba-8b9b-1f5b0deb0728]
  ```
  Kurulu sürüm köşeli parantez içinde **tam UUID** basıyor; dokümandaki örnek çıktı ise kısaltılmış (`[a1b2c3d4]`) gösteriyor — küçük bir doküman/uygulama farkı.
- Headless `-o stream-json` akışındaki `init` olayı: "`init`: Session metadata (session ID, model)." ([headless.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md))

**Nerede saklanır:**

> "**Location:** Sessions are stored in `~/.gemini/tmp/<project_hash>/chats/`, where `<project_hash>` is a unique identifier based on your project's root directory."
> — [session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)

**Ölçüm:** Dosya adı kalıbı `session-<YYYY-MM-DD>T<HH-MM>-<id-öneki>.json`, biçim **JSON** (JSONL değil):

```json
{
  "sessionId": "b74f1df7-462c-4a92-bfc2-b01d3749385c",
  "projectHash": "89d8bf48aa234d8aa0134b661857cd7f474c5717466a9e02c97314a8ca0fb1e0",
  "startTime": "2026-03-09T13:57:24.810Z",
  "lastUpdated": "2026-03-12T09:23:36.067Z",
  "messages": [ ... ]
}
```

Ek gözlem (dokümanda geçmiyor): 0.59.0 kurulumunda dizinler artık yalnızca hash ile değil, **okunabilir proje adlarıyla** da oluşturuluyor (`~/.gemini/tmp/winvestate-next/chats/`, `~/.gemini/tmp/agentdeck/chats/`). Eşleme `~/.gemini/projects.json` dosyasında tutuluyor (`{"projects": {"/home/codexist/Desktop/agentdeck": "agentdeck", ...}}`) ve her proje dizininde mutlak yolu içeren bir `.project_root` dosyası bulunuyor. Eski hash adlı dizinler yan yana duruyor. Bu adlandırma değişikliği resmî dokümanda **doğrulanamadı**.

Saklama politikası: varsayılan 30 gün; `general.sessionRetention` (`enabled`, `maxAge`, `maxCount`, `minRetention`) ile ayarlanır ([session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)).

### 3.3 cwd / dizin bağımlılığı

**Net cevap: Gemini üçü arasında en katı olanıdır — oturum geçmişi tamamen projeye (çalışma dizinine) göre kapsamlanır ve tam UUID vermek bile bu sınırı aşmaz.**

Doküman:

> "**Scope:** Sessions are project-specific. Switching directories to a different project switches to that project's session history."
> — [session-management.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md)

Üç ölçüm bunu kesinleştirdi:

1. **Listeleme dizine bağlı:** `gemini --list-sessions` → `/home/codexist/Desktop/winvestate-next` içinde `Available sessions for this project (52)`; `/home/codexist/Desktop/agentdeck` içinde ve taze scratch dizininde `No previous sessions found for this project.`
2. **Tam UUID bile sınırı aşmıyor (kritik):** `winvestate-next` projesine ait `b74f1df7-462c-4a92-bfc2-b01d3749385c` UUID'si, `agentdeck` dizininden `gemini --resume b74f1df7-... -p "hi"` ile denendi. Sonuç:
   ```
   Error resuming session: No previous sessions found for this project.
   ```
   Çıkış kodu `42`. (Headless dokümanına göre `42` = "Input error (invalid prompt or arguments)".)
3. **Anahtar cwd'dir, git deposu kökü değil:** `/home/codexist/Desktop/winvestate-next/winvestate-next-ui` dizininin kendi `.git`'i yoktur (`git rev-parse --show-toplevel` → `/home/codexist/Desktop/winvestate-next`), yani aynı git deposunun bir alt dizinidir. Buna rağmen orada `gemini --list-sessions` → `No previous sessions found for this project.` ve `~/.gemini/tmp/` altında ayrı bir `winvestate-next-ui` proje dizini mevcut. → **Proje anahtarı çalışma dizininden türetilir.**

**Worktree açısından sonuç (agentdeck için en kritik bulgu):** Farklı bir git worktree'si farklı bir mutlak yol → farklı `project_hash` → **tamamen ayrı ve birbirini görmeyen oturum havuzu**. Bir worktree'de başlatılan oturum başka bir worktree'den `--resume` ile, id verilse bile, açılamaz. Tek dolaylı çıkış yolu `--session-file <path>` ile oturumun JSON dosyasını doğrudan yüklemektir; bu bayrak `gemini --help` 0.59.0'da ve kaynak kodda var ancak `docs/` altında **belgelenmemiş** ve farklı bir proje dizininden çalışıp çalışmadığı bu araştırmada **doğrulanamadı**.

Doküman paralel çalışma için worktree'leri öneriyor ("use Git worktrees to give each Gemini session its own copy of the codebase"), yani bu izolasyon tasarım gereğidir ([git-worktrees.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/git-worktrees.md)).

### 3.4 Etkileşimsiz / programatik başlatma

`-p/--prompt` headless moddur ("Run in non-interactive (headless) mode with the given prompt", `gemini --help`). Çıktı biçimleri: `-o text|json|stream-json`.

`--resume` + `-p` kombinasyonu **argüman ayrıştırma düzeyinde kabul ediliyor** — ölçümde `gemini --resume <uuid> -p "hi"` komutu ayrıştırmayı geçip oturum çözümleme adımına ulaştı ve oradan `Error resuming session: ...` döndürdü. Ancak bu makinede hesap kimlik doğrulamadan geçemediği için (`IneligibleTierError`) **uçtan uca başarılı bir headless resume doğrulanamadı**. `docs/` altında `-p` ile `--resume`'u birlikte gösteren açık bir örnek de bulunamadı; `cli-reference.md` yalnızca pozisyonel prompt biçimini veriyor (`gemini -r "latest" "query"`), ki bu varsayılan olarak etkileşimli moda girer.

`-i/--prompt-interactive` ise promptu çalıştırıp etkileşimli modda devam eder (`gemini --help`).

### 3.5 Devam ettirilecek oturum yoksa

| Senaryo | Davranış | Çıkış kodu | Kaynak |
| --- | --- | --- | --- |
| `gemini --resume latest`, projede hiç oturum yok | `No previous sessions found for this project.` yazar ve **yeni oturuma devam eder** (ölçümde bu noktadan sonra kimlik doğrulama/model çağrısı adımına geçti) | **doğrulanamadı** — çıkış kodu bu makinedeki auth hatası tarafından gölgelendi | **Ölçüm** (kısmi) |
| `gemini --resume <bu projede olmayan uuid>` | `Error resuming session: No previous sessions found for this project.` ve **durur** | `42` | **Ölçüm** |
| `gemini --list-sessions`, oturum yok | `No previous sessions found for this project.` | `0` | **Ölçüm** |

Headless çıkış kodu sözleşmesi: `0` başarı, `1` genel hata/API hatası, `42` girdi hatası, `53` tur limiti aşıldı ([headless.md](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md)).

---

## 4. Karşılaştırma tablosu

| | **claude 2.1.269** | **codex 0.154.0** | **gemini 0.59.0** |
| --- | --- | --- | --- |
| **1. Komut biçimi** | Bayrak. `claude -c/--continue` (cwd'deki en son), `claude -r/--resume` (seçici), `--resume <id\|ad\|.jsonl yolu>`, `--from-pr`, `--fork-session`, `--session-id <uuid>` | Alt komut. `codex resume` (seçici), `codex resume --last`, `codex resume <id\|ad>`, `codex resume --all`, `codex exec resume [--last\|<id>]`, `codex fork` / `codex exec fork` | Bayrak. `gemini -r/--resume` (değersiz=en son, `latest`, index, UUID), `--list-sessions`, `--delete-session`, `--session-file <path>`, `--session-id <uuid>` |
| **2. Oturum kimliği** | `claude -p --output-format json` → `session_id`; seçici; hook'ların `transcript_path` alanı. Depolama: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` (JSONL) | `codex exec --json` → `{"type":"thread.started","thread_id":"..."}`; başlıkta `session id:`. Salt metin liste komutu yok (TUI seçici / `codex agents`). Depolama: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` (JSONL, ilk satır `session_meta`, `cwd` içerir) | `gemini --list-sessions` → index + başlık + tam UUID; `-o stream-json` `init` olayı. Depolama: `~/.gemini/tmp/<project_hash>/chats/session-<ts>-<önek>.json` (tek JSON dosyası, `sessionId` + `projectHash` + `messages[]`) |
| **3. cwd bağımlılığı** | **Karma.** `--continue` sadece cwd. `--resume <id>` **her dizinden çalışır** (v2.1.223+): önce mevcut proje + git worktree'leri, sonra makinedeki tüm projeler. Seçici varsayılanı mevcut worktree (`Ctrl+W` tüm worktree'ler, `Ctrl+A` tüm projeler). **Ölçüldü: dirA → dirB resume başarılı** | **Karma.** Seçici ve `--last` **cwd'ye göre filtrelenir**; `--all` bu filtreyi kapatır. Açık `<SESSION_ID>` ile resume **dizin sınırını aşar**. **Ölçüldü: dirA → dirB (id ile) başarılı; dirC'de `--last` bulamadı, `--last --all` buldu** | **Katı proje kapsamı.** Oturumlar yalnızca cwd'den türetilen projeye ait. **Tam UUID bile başka projeden açılamaz.** Anahtar cwd'dir, git deposu kökü değil. **Ölçüldü: yabancı UUID → `Error resuming session: No previous sessions found for this project.` (exit 42)** |
| **4. Etkileşimsiz resume** | Evet, belgeli: `claude -p --resume <id> --output-format json "..."`, ayrıca `claude -c -p "query"`. `--no-session-persistence` ile devre dışı. `--bg --resume <id>` arka planda. **Ölçüldü, exit 0** | Evet, birincil yol: `codex exec resume --last "..."` / `codex exec resume <id>`. `--json`, `-o`, `--output-schema`, `--ephemeral` destekli. **Tuzak: `codex exec resume`, `-s/--sandbox`, `-a/--ask-for-approval` ve `-C/--cd` kabul etmez.** **Ölçüldü, exit 0** | `-p` headless mevcut ve `--resume` ile ayrıştırma düzeyinde birlikte kabul ediliyor; **uçtan uca doğrulanamadı** (bu makinede auth hatası). Dokümanda `-p` + `--resume` birlikte örneklenmemiş |
| **5. Oturum yoksa** | `--continue`: **sessizce yeni oturum**, exit `0`. `--resume <bilinmeyen id>`: `No conversation found with session ID: <id>`, exit `1`. Seçiciden yükleme hatası: `Failed to resume the conversation`, exit `1` | `exec resume --last`: **sessizce yeni oturum**, exit `0`. `exec resume <bilinmeyen id>`: `no rollout found for thread id <id> (code -32600)`, exit `1` | `--resume latest`: uyarı basıp **yeni oturuma devam eder** (çıkış kodu doğrulanamadı). `--resume <yabancı uuid>`: `Error resuming session: ...` ve durur, exit `42` |

### Agentdeck için pratik özet

- **Worktree başına paralel oturum** senaryosunda oturumu farklı bir dizinden geri açabilmek gerekiyorsa: `claude` sorunsuz, `codex` yalnızca **açık session id** ile (veya `--all` ile), `gemini` ise test edilen 0.59.0'da ve ölçülen yolda **başarısız** — `--resume` proje hash'iyle sınırlı olduğu için başka bir worktree'nin oturumunu bulamadı. Bu, sürümden bağımsız bir imkânsızlık iddiası değildir; belgelenmemiş `--session-file` yolu (açık kalan madde 3) ve sonraki sürümler ölçülmedi.
- Her üç CLI'da da "en son oturum" varyantı (`--continue`, `--last`, `--resume latest`) oturum bulunamadığında **sessizce yeni oturum açıyor** — bu, otomasyonda sessiz bağlam kaybı riskidir. Sağlam yol, oturum id'sini ilk çalıştırmada yakalayıp (`--output-format json` / `--json`) sonraki çağrılarda **açıkça** vermektir; bu durumda claude ve codex düzgün hata + sıfırdan farklı çıkış kodu döner.

---

## 5. Açık kalanlar / doğrulanamayanlar

1. **Gemini headless resume uçtan uca:** Bu makinedeki Gemini hesabı `IneligibleTierError` ile kimlik doğrulamadan geçemiyor, bu yüzden `gemini --resume <id> -p "..."` komutunun başarılı bir devam ettirme yapıp yapmadığı **doğrulanamadı**. Yalnızca ayrıştırma ve oturum çözümleme adımlarına ulaştığı gözlendi.
2. **Gemini `--resume latest` çıkış kodu (oturum yokken):** Auth hatası çıktıyı gölgelediği için temiz bir çıkış kodu ölçülemedi. "Yeni oturuma devam ediyor" gözlemi geçerli, çıkış kodu **doğrulanamadı**.
3. **Gemini `--session-file <path>`:** `gemini --help` 0.59.0'da ve kaynak kodda mevcut, `docs/` altında belgelenmemiş. Farklı bir proje dizininden başka bir projenin oturum JSON'unu yükleyip yükleyemediği **test edilmedi**.
4. **Gemini'nin okunabilir proje dizini adlandırması** (`~/.gemini/tmp/agentdeck/` + `~/.gemini/projects.json` + `.project_root`): yerel gözlemle doğrulandı, ancak resmî dokümanda karşılığı bulunamadı (doküman hâlâ yalnızca `<project_hash>` diyor).
5. **Gemini değersiz `--resume` kullanımı:** Doküman `gemini --resume` (argümansız) diyor, `--help` ise `latest` veya index istiyor gibi görünüyor. Argümansız kullanım **test edilmedi**.
6. **Codex `--last` cwd eşleştirme koşulu:** Filtrenin `session_meta.cwd`'ye mi yoksa en son `turn_context.cwd`'ye mi baktığı kaynak koddan **doğrulanmadı**; yalnızca davranışsal olarak "yalnızca ilk cwd'ye bakmıyor" sonucu çıkarıldı.
7. **Codex oturum dosyası yolunun resmî kaynağı:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` yolu yerel gözlemle kesin, ancak `openai/codex` `docs/` içinde bu yolu açıkça yazan bir sayfa bulunamadı.
8. **Codex etkileşimli TUI seçicileri** (`codex resume`, `codex fork`, `codex agents`): PTY gerektirdiği için test edilmedi; iddialar yalnızca `--help` metnine dayanıyor.
9. **Claude çapraz-proje id aramasında kopya transcript durumu:** "resolves the ID only when exactly one other project holds a transcript with messages for it" ifadesi dokümandan alındı, **test edilmedi**.
10. **Claude `--continue` + arka planda çalışan oturum** durumu (`Your most recent conversation is running in the background`): yalnızca dokümana dayanıyor, **test edilmedi**.
11. Üç CLI'da da **kilit/eşzamanlılık** davranışı (aynı oturumu iki süreçten aynı anda resume etmek) incelenmedi. Claude dokümanı bu durumda mesajların tek transcript'e karışacağını söylüyor; codex ve gemini için karşılığı araştırılmadı.

---

## 6. Kaynaklar

**Claude Code**

- https://code.claude.com/docs/en/cli-reference (`https://docs.claude.com/en/docs/claude-code/cli-reference` adresinden 301 ile yönleniyor)
- https://code.claude.com/docs/en/sessions
- `claude --help` (sürüm 2.1.269, yerel)
- Yerel ölçümler: `~/.claude/projects/` dizin yapısı, `claude -p --output-format json`, `claude -p --resume` (dizinler arası), `claude -p --continue` (boş dizin), bilinmeyen UUID ile `--resume`

**OpenAI Codex CLI**

- https://github.com/openai/codex — `README.md`, `docs/exec.md`, `docs/config.md`
- https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs (`--all` bayrağının "disables cwd filtering" açıklaması)
- https://learn.chatgpt.com/docs/non-interactive-mode (`https://developers.openai.com/codex/noninteractive` adresinden 308 ile yönleniyor; `docs/exec.md` buraya işaret ediyor)
- `codex --help`, `codex resume --help`, `codex exec --help`, `codex exec resume --help`, `codex fork --help`, `codex exec fork --help`, `codex agents --help` (sürüm 0.154.0, yerel)
- Yerel ölçümler: `~/.codex/sessions/` dizin yapısı ve `session_meta`/`turn_context` kayıtları, `codex exec --json`, dizinler arası `codex exec resume <id>`, `codex exec resume --last` (± `--all`), bilinmeyen UUID ile resume

**Google Gemini CLI**

- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/session-management.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/git-worktrees.md
- https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/config/config.ts (`--resume` / `--session-id` / `--session-file` karşılıklı dışlama kuralı ve bayrak tanımları)
- `gemini --help` (sürüm 0.59.0, yerel)
- Yerel ölçümler: `~/.gemini/tmp/*/chats/` dosya biçimi, `~/.gemini/projects.json`, `.project_root`, farklı dizinlerde `gemini --list-sessions`, yabancı UUID ile `gemini --resume`, git alt dizini testi
