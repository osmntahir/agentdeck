# AgentDeck V0 — bağımsız inceleme ve mevcut karar incelemesinin değerlendirmesi

> Bu rapor tarihli kanıttır; içeriği sonradan düzeltilmez ve inceleme sırasındaki ADR dosya adları korunmuştur. Numaralar daha sonra tekilleştirildi: `0002-scrollback-session-record.md` → [`0004-terminal-state-and-scrollback.md`](../adr/0004-terminal-state-and-scrollback.md), `0003-degraded-is-derived-overlay.md` → [`0005-degraded-is-derived-overlay.md`](../adr/0005-degraded-is-derived-overlay.md); 0001/0002/0003 numaraları değişmedi ve [`0006-base-commit-and-archive.md`](../adr/0006-base-commit-and-archive.md) yeni eklendi. Güncel normatif karar [spec revizyon 2](../specs/agentdeck-v0.md), bulguların tek tek sonucu [karar uzlaştırması](2026-09-12-decision-reconciliation.md).


Tarih: 12 Eylül 2026.
Kapsam: `CONTEXT.md`, `README.md`, `CLAUDE.md`, `docs/agents/*`, 4 ADR, 2 araştırma belgesi, `docs/specs/agentdeck-v0.md`, GitHub haritası (#1) ve 19 alt ticket'ın resolution yorumları, `src/server/*` ile `electron/main.js`/`scripts/launch.mjs`, ve `docs/reviews/2026-09-12-v0-decisions-review.md`.

Önceki incelemeden farkı: bu tur **çalışma zamanı deneyleri yapıldı**. Kurulu `claude` 2.1.269, `gemini` 0.59.0 ve `codex` 0.154.0 üzerinde, projenin kendi `node-pty` sürümüyle gerçek PTY'de ölçüm alındı. Ölçümler aşağıda **M1–M9** olarak numaralandırıldı. Bu yine de ürün kabul testi değildir: AgentDeck daemon'ı çalıştırılmadı, ürün koduna ve kararlara dokunulmadı.

## Özet yargı

Mevcut incelemenin ana tezine katılıyorum: altyapı kararları sağlam, günlük kullanım sözleşmeleri geride. Dokuz bulgunun **dokuzu da geçerli**; ikisinin şiddeti raporda olduğundan yüksek, birinin çerçevesi dar.

Buna karşılık, incelemenin kaçırdığı ve uygulamaya başlamadan kapatılması gereken **altı bağımsız bulgu** var. İkisi yüksek öncelikli ve ikisi de aynı kökten geliyor: *yeni bir worktree yolu, çalışmaya hazır bir ajan ortamı değildir* ve *ham bayt halkası, ekran değildir*.

---

## 1. Mevcut raporun bulgularının değerlendirmesi

| # | Bulgu | Yargı | Şiddet (benim) |
|---|---|---|---|
| 1 | Otomatik orphan worktree süpürmesi | Doğrulandı, katılıyorum | Yüksek |
| 2 | 256 KiB halka ekranı garanti etmiyor | Doğrulandı, **şiddeti artırılmalı** | Yüksek |
| 3 | Resume çakışma listesi eksik | **Deneyle doğrulandı** | Yüksek |
| 4 | Restart başarısızlığında çıkış yolu yok | **Deneyle doğrulandı, daha ağır** | Yüksek |
| 5 | Commit edilmiş iş görünmez | Doğrulandı, katılıyorum | Orta-yüksek |
| 6 | `idle` ≠ "beni bekliyor" | Doğru ama çerçeve dar | Orta |
| 7 | Okunamayan scrollback boş görünüyor | Doğrulandı, ucuz düzeltme | Düşük-orta |
| 8 | Silme onayının kapsamı/maliyeti | Doğrulandı, katılıyorum | Orta |
| 9 | Worktree hazırlığı eksik varsayım | Doğrulandı, **10. bulguyla birleştirilmeli** | Orta |

### 1.1 Katıldığım ve kanıtı güçlendirdiğim bulgular

**(1) Orphan süpürmesi.** [#5](https://github.com/osmntahir/agentdeck/issues/5) karar tablosu ("Kayıt yok, yol bizim kökte → State temiz yüklendiyse açılışta dizin + git kaydı süpürülür") ve ADR-0001 son paragrafı bunu açıkça söylüyor; [#19](https://github.com/osmntahir/agentdeck/issues/19) yalnız *geçersiz* state için süpürmeyi yasaklıyor. Rapora ek olarak iki nokta:

- Bu, sistemdeki **tek otomatik yıkıcı işlem**. Haritanın kendi ilkesi ("temizlik yalnızca açık oturum silme ve proje kaldırmadır", "kirli kopya sessiz `--force` ile gitmez") ile doğrudan çelişiyor. Kullanıcı onayı gerektiren bir silme ile hiç sormadan yapılan bir silme aynı belgede yan yana duruyor.
- Tetikleyici hipotetik değil, **spec'in kendi yazdığı akış**: #19 "migration öncesi timestamp'li yedek" tutuyor. Başarısız bir migration sonrası o yedeğin geri konması, şema bakımından kusursuz ama eski bir state üretir. Yedekten sonra açılan her oturumun worktree'si bir sonraki açılışta kayıtsız görünür ve silinir.

Öneri aynen doğru: açılışta yalnız keşfet ve bildir. Bunun maliyeti de düşük — harita zaten `degraded` overlay'ine ve `delete-preview` + confirmation token akışına sahip; orphan worktree aynı onay yoluna bağlanabilir, yeni mekanizma gerekmez.

**(3) `--session-file` çakışması — doğrulandı (M1).**

```
$ gemini --session-id <uuid> --session-file ./s.json -p "hi"
The flags --resume, --session-id, and --session-file are mutually exclusive. Please provide only one.
exit 1
```

[#18](https://github.com/osmntahir/agentdeck/issues/18) çakışma listesi: `--session-id`, `--session-id=`, `--resume`, `--resume=`, `-r`, `--continue`, `-c`, `--last`, `--fork-session` ve `resume` alt komutu. `--session-file` listede yok. `gemini --session-file ./oturum.json` konservatif lexer'ın tanımına *tam uyan* statik basit bir çağrıdır (literal executable + literal argümanlar), dolayısıyla otomatik `--session-id` enjeksiyonu alır ve kullanıcının geçerli komutu ilk koşuda ölür. Aynı sınıfta gözden geçirilmesi gerekenler: Claude tarafında `--from-pr` (seçici açar) ve Gemini tarafında `--list-sessions` / `--delete-session`.

Asıl ders bayrağın tek tek eklenmesi değil: **çakışma listesi kara liste olarak tutulduğu sürece CLI sürümleriyle birlikte eskiyecek.** Beyaz liste (yalnız tanınan bayrak kümesi otomatik resume'a uygundur, gerisi aynen çalışır) aynı hedefi eskimeye dayanıklı biçimde verir.

**(4) Restart çıkmazı — doğrulandı ve rapordakinden ağır (M2, M3, M4).**

Rapor bunu "çıkış yolu eksik" diye tanımlıyor. Ölçüm, oturumun **kalıcı olarak kilitlendiğini** gösteriyor:

- **M2:** Yeni bir dizinde `claude --session-id <uuid>` çalıştırıldığında CLI 267 ms içinde "Quick safety check: Is this a project you trust?" onay ekranını basıyor ve **girdi bekliyor**. 60 saniye boyunca tek bayt daha çıktı üretmiyor, süreç canlı kalıyor.
- **M3:** Kullanıcı onayı vermediği için `~/.claude/projects/**` altında o UUID'ye ait **hiçbir transcript oluşmuyor**.
- **M4:** Güvenilen bir dizinde `claude --resume <bilinmeyen-uuid>` etkileşimli TUI'de de `No conversation found with session ID: …` ile **exit 1** veriyor.

Kararın kuralı "ilk koşu `--session-id`, sonraki her koşu `--resume`" olduğu için: ilk koşu konuşma yazmadan biterse (onay verilmedi, CLI bulunamadı, auth başarısız — araştırma belgesinin kendisi bu makinede Gemini'nin `IneligibleTierError` ile auth'tan geçemediğini yazıyor), **o Session bir daha asla başarıyla açılamaz**. Her restart aynı saniyede exit 1 verir. Kullanıcıya sunulan tek çıkış "Yeni Session aç" ve bu, proje HEAD'inden yeni bir worktree yaratıp mevcut worktree'deki commit edilmemiş işi geride bırakır.

Bu, tek başına "uygulamaya hazır" damgasını geri çektirecek bir hata sınıfıdır ve V0'ın çekirdek vaadinin (*başlat → çalış → incele → devam et*) tam ortasına düşer.

**(5) Commit edilmiş iş.** Katılıyorum; ekleyeceğim iki nokta işi ucuzlatıyor ve büyütüyor:

- Başlangıç OID'si zaten kararlaştırılmış durumda: [#15](https://github.com/osmntahir/agentdeck/issues/15) "worktree, create anında proje HEAD'inin çözümlenmiş commit OID'sinden oluşturulur" diyor. Yani değer *hesaplanıyor*, sadece **kayda yazılmıyor**. `baseCommit` alanını Session kaydına eklemek neredeyse bedava; "bu çalışmanın toplam değişikliği" görünümü onun üstüne gelir.
- Boşluk diff'ten büyük: oturum silindikten sonra `agentdeck/<slug>-<sessionId>` branch'i kalıyor (doğru karar), ama üründe o branch'leri **görecek hiçbir yüzey yok**. Kullanıcı 20 oturum sonra deposunda adını hatırlamadığı 20 branch'le kalıyor. "İş nereye gitti" sorusunun cevabı V0'da hiçbir yerde yok.

**(7), (8), (9).** Üçüne de katılıyorum. (8)'e bir sertleştirme: "kirli" tanımı `git status --short` olduğu için ignored dosyalar kapsam dışı — ama (9)'un doğrudan sonucu olarak kullanıcı yeni worktree'yi çalışır hale getirmek için `.env` benzeri ignored dosyaları oraya **elle kopyalamak zorunda**. Yani silme akışı, tam da kullanıcının elle koyduğu dosyaları onay metninde hiç anmadan siler. İki bulgu birbirini besliyor.

### 1.2 Çerçevesine katılmadığım bulgu

**(6) `idle` göstergesi.** Teşhis doğru, ama öneri ("hedef metnini sessiz/hatalı oturumları taramaya düşür") gereğinden fazla geri çekiliyor. Ölçüm iki şey söylüyor:

- **M2:** `idle` sinyali pratikte *temiz* çalışıyor. Kullanıcı girdisi bekleyen Claude TUI'si 60 saniye boyunca sıfır bayt üretti; spinner/timer gürültüsü yok. Yani 30 sn eşiği yanlış `running` üretmiyor.
- **M2 + M5 (aşağıda 13. bulgu):** Yeni bir worktree oturumunun **en sık karşılaşılan** ilk hali zaten "kullanıcıyı bekliyor"dur — güven onayı ekranı. Bu deterministik bir durum, stdout regex'i gerektirmiyor.

Yani doğru düzeltme vaadi tamamen daraltmak değil: `idle`'ın anlamsal iddia taşımadığını korumak, ama ürünün ilk kullanımdaki en yaygın bekleme durumunu **bilinen bir akış olarak** ele almak. Kapsam kararı yine dar kalır, kullanıcı vaadi boşa düşmez.

### 1.3 Raporda katılmadığım tek endorsement

Rapor "Tek state poll ve bounded preview: başlangıç ölçeğinde makul" diyerek önizleme kararını **korunacaklar** listesine koyuyor. Bu doğru değil — aşağıdaki 11. bulgu, spec'te tarif edildiği haliyle düz metin önizlemenin ürünün ana ekranında okunamaz çıktı ürettiğini gösteriyor. Poll mimarisi makul; önizlemenin **içeriği** yeniden kararlaştırılmalı.

Ayrıca (2) için önerilen xterm `serialize` eklentisi bir istemci Terminal nesnesi üzerinde çalışır; sunucuda kullanmak için halkayı besleyen **headless emülatör** gerekir ve bu oturum başına sürekli CPU demektir. Daha ucuz bir V0 adayı prototipte birlikte ölçülmeli: yeniden bağlanmada PTY'ye bir satır/sütun **resize dürtmesi** (SIGWINCH) göndermek, tam ekran TUI'lerin çoğunda tam yeniden çizim tetikler. Garanti değil — uygulamanın SIGWINCH'e yanıt vermesine bağlı — ama ölçülmeden eleneceğine prototipte serialize ile yan yana konmalı.

### 1.4 Doğrulanan yan iddialar

- **Xirp alıntısı doğru (M9).** Blog 10 Ağustos 2026 tarihli; "vendor-neutral agentic development environment", "Every session operates in its own worktree", "Context is decoupled from any single agent or harness; switch tools mid-project, and the full working state carries over" ve Portal ile organizasyon bağlamı iddiaları raporda doğru aktarılmış. Raporun "aynı deneyimi sunduğunu söylemek erken" değerlendirmesi de yerinde: Xirp'in vurguladığı *araç değiştirince bağlamın taşınması* V0'da yok.
- **ADR numara çakışması doğru:** iki `0002`, iki `0003`.
- **Göreli ADR linkleri doğru:** #3 resolution yorumu `[ADR-0002](docs/adr/0002-scrollback-session-record.md)` içeriyor; issue yorumundaki göreli yol depo dosyasına çözülmez.
- **"Destroy atomiktir" çelişkisi doğru:** ADR-0001 "atomik" derken #5 "kısmi başarı geri alınmaz", spec ise "işlem kısmi başarısını rollback olmuş gibi göstermemek esastır" diyor.

---

## 2. Bağımsız bulgular

### 10. Yüksek — Her yeni worktree, her ajanda bir güven onayı kapısıdır

**Kanıt (M2, M5).** Üç CLI de güveni **mutlak dizin yoluna** göre tutuyor:

- `~/.claude.json` → `projects["<mutlak yol>"].hasTrustDialogAccepted` (bu makinede 30 kayıt)
- `~/.codex/config.toml` → `[projects."<mutlak yol>"] trust_level = "trusted"`
- Gemini tarafında da proje bazlı ayar dizini (`~/.gemini/projects.json`) mevcut.

AgentDeck'in tasarımı gereği her worktree oturumu **daha önce hiç görülmemiş** bir mutlak yolda (`~/.agentdeck/worktrees/<projectId>/<sessionId>`) açılır. Deponun kendisi güvenilir olsa bile worktree yolu değişik olduğu için güven devralınmaz. Sonuç: **her tek tık preset oturumu, TUI içinde bir onay ekranıyla başlar.**

Bunun zinciri:

1. "Tek tık ile oturum aç" vaadi gerçekte "tek tık + terminale geç + onayı oku + Enter"dır. V0'ın ilk açılış yolculuğu bunu hiç anmıyor.
2. Onay verilene kadar ajan **hiçbir şey yazmaz** — 4. bulgudaki kalıcı restart kilidi büyük olasılıkla en çok buradan tetiklenecek.
3. Grid'de bu oturum 30 sn sonra `idle` görünür; teknik olarak doğru, ürün açısından tam da "beni bekliyor" durumudur.

Karar gerektiren nokta: V0 bunu (a) yalnız ilk kullanımda açıkça anlatıp kullanıcıya bırakır mı, (b) oturum oluşturma diyalogunda "ilk çalıştırmada ajan klasör onayı isteyecek" uyarısı gösterir mi, yoksa (c) kullanıcının ajan yapılandırmasına yolu önceden yazar mı. (c) kullanıcının `~/.claude.json` / `~/.codex/config.toml` dosyasına yazmak demektir ve bilinçli bir ürün kararı olmadan yapılmamalı; araştırma belgesinin "deneylerdeki izin bayrakları ürün varsayılanlarına taşınmamalı" uyarısı burada da geçerli. Ama sessizce görmezden gelinemez.

Bu bulgu, mevcut raporun 9. bulgusuyla (bağımlılıklar, `.env`, portlar) aynı kökten: **temiz bir HEAD kopyası, çalışmaya hazır bir ajan ortamı değildir.** İkisi tek kararda birleştirilmeli.

### 11. Yüksek — Tarama grid'inin düz metin önizlemesi TUI ajanlarda okunamaz

**Kanıt (M6).** M2'de kaydedilen gerçek Claude Code çıktısına naif ANSI temizliği uygulandığında:

```
folderfirst.
ClaudeCode'llbeabletoread,edit,andexecutefileshere.
Securityguide
❯No,exit
Yes,Itrustthisfolder
Entertoconfirm·Esctocancel
```

Sebep ham çıktıda: CLI kelimeleri boşlukla değil **sütun konumlandırmayla** yazıyor — `\e[2GQuick\e[8Gsafety\e[15Gcheck:`. Escape dizileri atılınca kelimeler birbirine yapışıyor.

[#8](https://github.com/osmntahir/agentdeck/issues/8) ve [#17](https://github.com/osmntahir/agentdeck/issues/17) "halkadan türetilmiş, oturum başına en çok 2 KiB **düz metin** özet" diyor ve bu özet **ürünün ana ekranındaki 24 kartın** içeriği. Yani tarama görünümü, ajan CLI'ları için tasarlandığı halde, amiral gemisi preset'te anlamsız metin gösterecek.

Bu, raporun 2. bulgusuyla aynı kökten (ham bayt ≠ ekran) ama daha kötü yerde: 2. bulgu odak terminaline dönüşü etkiliyor, bu bulgu **varsayılan görünümü** etkiliyor. Seçenekler — sunucuda headless emülatörle son N satırı render etmek, önizlemeyi tamamen bırakıp yalnız metadata göstermek, ya da kartta küçük salt-okunur bir terminal render'ı kullanmak — farklı maliyet profillerine sahip ve prototiple ölçülmeli. "Ucuz düz metin özet" varsayımı ölçülmeden taşınamaz.

### 12. Orta — Ham bayt halkası ile JSON metin frame'i aynı anda tutulamaz

[#3](https://github.com/osmntahir/agentdeck/issues/3) ve [#17](https://github.com/osmntahir/agentdeck/issues/17) halkanın **ham PTY baytı** ve **262144 UTF-8 bayt** olduğunu söylüyor. [#17](https://github.com/osmntahir/agentdeck/issues/17) aynı zamanda "JSON/binary protokol geçişi V0 gereği değildir" diyor ve frame sınırlarını UTF-8 parça olarak veriyor.

Bu ikisi birlikte tutarlı değil:

- **Kanıt (M7):** `node-pty` varsayılanı `encoding: 'utf8'`'dir (`unixTerminal.js:64`) ve sokete `setEncoding` uygular; yani bugün akış zaten çözülmüş string'dir, ham bayt değil. Ham bayt için `encoding: null` gerekir.
- Ham baytı seçersen, UTF-8 olmayan çıktı (binary dosya, bozuk dizi) JSON metin frame'ine kayıpsız sığmaz; `U+FFFD` ikamesi ANSI akışını bozabilir. Binary WS frame'i ya da base64 gerekir — ikisi de "protokol geçişi yok" kararıyla çelişir.
- Çözülmüş UTF-8 akışını seçersen karar metnindeki "ham bayt" ifadesi yanlıştır ve 262144 sınırının bayt mı karakter mi olduğu uygulamada yeniden tartışılır.

İkisinden biri seçilmeli. Pratik öneri: uçtan uca çözülmüş UTF-8'de kalmak (TUI ajanları için yeterli), sınırı "UTF-8 kodlamasında 262144 bayt" diye tanımlamak ve "ham bayt" ifadesini spec'ten çıkarmak. Bu, 2. dilimin ilk gününde karşılaşılacak bir belirsizlik.

### 13. Düşük — Replay'in "ilk parça tüm halka" kuralı 32 KiB frame tavanıyla çelişiyor

[#3](https://github.com/osmntahir/agentdeck/issues/3): "İlk parça **tüm halka**. İstemci ekranı sıfırlayıp yazar." [#19](https://github.com/osmntahir/agentdeck/issues/19) da replay'i tek kritik bölüm olarak tanımlıyor. [#17](https://github.com/osmntahir/agentdeck/issues/17): "Tek output frame en fazla 32 KiB." 256 KiB halka en az 8 frame eder.

Çözümü basit (replay birden çok frame, sonunda `replay-end` işareti; istemci reset'i ilk frame'de yapar), ama spec bugün iki farklı şey söylüyor ve replay/live sınırı ile istemci reset noktası uygulamanın en yarış-hassas yeri. Yazıya dökülmeli.

### 14. Orta — Daemon'ın başlatıldığı andaki env, sonsuza kadar her oturumun env'i olur

`scripts/launch.mjs` → `electron/main.js` (`daemonEnv()` yalnız PATH ekliyor) → `sessions.spawn` (`{...process.env}`) zinciriyle, daemon'ın doğduğu andaki ortam **değişmeden** her PTY'ye geçiyor. Daemon pencereden uzun yaşadığı için (ürünün temel vaadi) haftalar sonra açılan bir oturum hâlâ o eski env'i alır; restart bile tazelemez.

Somut sonuçları: `nvm` sürümü daemon başlangıcında sabitlenir; kullanıcı sonradan ekleyeceği API anahtarını görmek için daemon'ı yeniden başlatmak zorundadır; ve daemon bir ajan terminalinden başlatılırsa o ajanın değişkenleri sızar. **Kanıt:** bu oturumda `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID` dahil 12 değişken ortamda mevcut; bu ortamdan başlatılan bir daemon hepsini her ajan oturumuna taşır.

Spec "shell init/profil davranışı kullanıcı ortamına aittir" diyor ama bu, *hangi ortamın* miras alındığı sorusunu cevaplamıyor. V0'ın cevabı "login kabuğu zaten profili okur, daemon env'i yalnız temel değişkenlerle sınırlanır" olabilir — ama açık yazılmalı.

### 15. Orta — Codex konuşma kimliği, kanca veya `CODEX_HOME` olmadan da bulunabilir

[#4](https://github.com/osmntahir/agentdeck/issues/4) Codex'i otomatik resume'dan çıkarıyor; gerekçe doğru: `SessionStart` kancası cwd'yi kirletir, izole `CODEX_HOME` kullanıcının auth'unu koparır. Ama üçüncü bir yol değerlendirilmemiş.

**Kanıt (M8):** Codex her koşuyu `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<id>.jsonl` altına yazıyor ve dosyanın **ilk satırı** şunu taşıyor:

```json
{"session_id":"01a09552-…","cwd":"/home/codexist/Desktop/agentdeck",
 "timestamp":"2026-09-12T11:13:16.813Z","originator":"codex-tui","cli_version":"0.154.0"}
```

AgentDeck'in worktree tasarımı bu eşleşmeyi **tekil** yapıyor: her oturumun cwd'si kendine ait. Yani koşu bittikten sonra, o günün dizininde `cwd == session.cwd` olan en yeni rollout okunarak konuşma kimliği bulunabilir; restart `codex resume <id>` olur. Kullanıcının cwd'sine dosya yazılmaz, `CODEX_HOME` değiştirilmez, stdout scrape edilmez — yalnız okuma yapılır.

Dürüst sınırlar: bu dosya biçimi belgelenmiş bir sözleşme değil ve araştırma belgesi iç biçimlere dayanmaya karşı uyarıyor; `shared` izolasyonda cwd tekil olmadığı için eşleşme belirsizleşir; bulunamazsa davranış bugünkü gibi (Command birebir) kalmalı. Yine de "Codex'te resume mümkün değil" diye kapatılmış bir kapının aslında açık olduğunu gösteriyor ve V0'ın çekirdek döngüsünü üç ajanın üçünde de tamamlar. En azından bilinçli bir *hayır* olarak kaydedilmeli.

---

## 3. Kararların hangi kısmı sağlam

Mevcut raporun "korunacaklar" listesine büyük ölçüde katılıyorum — daemon sahipliği, Session/Run/Conversation id ayrımı, lifecycle/activity/health ayrımı, worktree ile branch'in ayrı ömürleri, tek yazıcı + süreç grubu doğrulaması, copy-on-write state ve bozulmada durma, grid'in sabit sırası ve klavye modeli, bounded diff, 32 PTY sınırının ölçülmüş kapasite diye sunulmaması.

Bunlara ekleyeceğim: [#2](https://github.com/osmntahir/agentdeck/issues/2)'nin "sinyal göndermek ölüm kanıtı değildir" ve [#19](https://github.com/osmntahir/agentdeck/issues/19)'un "disk yazımı başarısızsa API başarı demez, ama live süreç öldürülmez" ayrımları bu ölçekteki projelerde nadiren bu kadar doğru kurulur. Mevcut kodun `kill()` timeout'unu başarı sayması ve `store.load()`'un parse hatasında boş state'e düşmesi karşısında, bu iki kararın uygulamada gerçekten uygulanması en yüksek getirili iş.

Tek istisna: 1.3'te yazdığım üzere "bounded düz metin preview" korunacaklar listesinden çıkarılmalı.

---

## 4. Önerilen sıra

Mevcut raporun 5 adımlı sırasına katılıyorum; iki yerini değiştiriyorum.

1. **Güvenilir tek oturum** — daemon sahipliği, state doğrulama, Run kimliği, doğrulanmış stop, worktree koruma. **Otomatik orphan süpürmesi kaldırılır** (bulgu 1). Bu dilim bugünkü kodun üç somut hatasını da kapatır.
2. **İlk oturum gerçekten çalışıyor mu** — gerçek `claude`/`codex`/`gemini` ile tek bir worktree oturumu açılır ve *insan* onayından geçer (bulgu 10). Bu adım eskiden listede yoktu; 4. ve 10. bulguların ikisi de burada yakalanır ve maliyeti bir saattir.
3. **Gerçek terminal geri dönüşü + önizleme** — sessiz TUI'ye A→B→A ve Terminal→Diff→Terminal dönüşü, halka taşması, yeni istemci bağlantısı; aynı prototipte kart önizlemesinin okunabilirliği ölçülür (bulgu 2, 11). Protokol/encoding kararı burada kilitlenir (bulgu 12, 13).
4. **Başlat → çalış → incele → devam et** — aynı worktree'de resume hatasından çıkış, açık restart semantiği, `baseCommit` ve görev sonucunun görünürlüğü (bulgu 4, 5, 15).
5. **Çoklu iş taraması** — birkaç gerçek oturumla grid, sessizlik göstergesi, klavye/odak. Sonra sentetik 32 PTY / 256 kayıt sınır testleri.
6. **Kabul ve anlatım hizası** — disk hatası, silme onayı kapsamı (bulgu 8, 9), büyük çıktı; README/ADR/spec'in tek davranışı anlatması; ADR numaralarının tekilleştirilmesi.

## 5. Önerilen frontier

Mevcut raporun beş sorusuna katılıyorum. Üç soru daha eklenmeli ve biri yeniden yazılmalı:

1. Kayıtsız worktree'ler kullanıcı işi kaybedilmeden nasıl keşfedilir ve temizlenir? *(rapordan; blokeleyici)*
2. Halka taştıktan sonra sessiz bir TUI'ye doğru ekranla nasıl dönülür **ve tarama kartı ne gösterir?** *(rapordan, bulgu 11 ile genişletildi; blokeleyici — tek prototip iki soruyu birden cevaplar)*
3. Otomatik resume hangi komutları dönüştürür (kara liste değil beyaz liste) ve başarısızlığında aynı iş nasıl sürdürülür? *(rapordan, bulgu 3 ile sertleştirildi; blokeleyici)*
4. **Yeni bir worktree oturumu ilk çalıştırmada neyi hazır bulur — güven onayı, ignored dosyalar, bağımlılıklar?** *(yeni; bulgu 9 + 10; blokeleyici)*
5. **Halka ve WS protokolü ham bayt mı, çözülmüş UTF-8 mü; replay kaç frame'dir?** *(yeni; bulgu 12 + 13; 2. dilimi bloke eder)*
6. Commit edilmiş ve edilmemiş görev sonucu hangi referansa göre incelenir, silinmiş oturumun branch'i nasıl bulunur? *(rapordan, bulgu 5 ile genişletildi)*
7. Silme onayı branch değişimini, ignored dosyaları ve büyük dosya maliyetini nasıl ele alır? *(rapordan)*
8. **Codex konuşma kimliği rollout metadatasından okunmalı mı, yoksa bilinçli olarak hayır mı?** *(yeni; bulgu 15; blokeleyici değil)*

Ek olarak daemon env sözleşmesi (bulgu 14) küçük bir karar revizyonuyla kapanabilir; ayrı ticket gerektirmez.

## 6. İnceleme sınırları

- AgentDeck daemon'ı çalıştırılmadı; ürün kodu, kararlar ve mevcut rapor değiştirilmedi. Yalnız bu dosya eklendi.
- M1–M8 bu makinedeki kurulu sürümlere (`claude` 2.1.269, `codex` 0.154.0, `gemini` 0.59.0) ve bu kullanıcının yapılandırmasına aittir; başka sürüm/ortamda farklı sonuç verebilir. Hiçbiri sürüm bağımsız garanti değildir.
- Gemini tarafında model çağrısı gerektiren yollar bu makinede auth edilemediği için ölçülmedi; M1 yalnız argüman doğrulama katmanını kanıtlar.
- Güven onayı akışı yalnız Claude'da PTY içinde gözlendi; Codex ve Gemini için kanıt yapılandırma dosyalarının yol bazlı güven kaydı tutmasıdır, uçtan uca TUI akışı değil.
- Bulgu 15 okunan bir iç dosya biçimine dayanır; Codex bunu belgelenmiş bir arayüz olarak sunmaz.
- Bu inceleme herhangi bir testin geçtiği anlamına gelmez.
