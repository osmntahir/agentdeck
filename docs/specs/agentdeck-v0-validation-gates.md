# AgentDeck V0 doğrulama kapıları

Tarih: 2026-09-12. Tasarım sözleşmesi [spec revizyon 2](agentdeck-v0.md). Buradaki kutular **ürün test sonucu değildir**. Kapı sahibi sonuç/komut/sürüm/ortam ve varsa fixture bağlantısını kaydetmeden kutu işaretlenmez. İnsan trust/auth onayı ajan tarafından verilmiş gibi yazılmaz.

## G1 — Terminal temsili ve protokol (tasarım devir kapısı) — **kapandı 12 Eylül 2026**

Ortam: Node 22.19.0, `@xterm/headless` 6.0.0, `@xterm/addon-serialize` 0.14.0, `@xterm/xterm` 6.0.0, Chrome (yerel), Linux. Script'ler: [state](../research/terminal-state-probe.cjs), [protokol](../research/terminal-protocol-probe.cjs), [yük](../research/terminal-load-probe.cjs), [tarayıcı eşitliği](../research/terminal-browser-parity.cjs). Sonuçlar: [doğrulama notu](../research/terminal-state-validation.md). Ölçümlerin tamamı sentetiktir; gerçek ajan CLI'ları G2'nin işidir.

- [x] **Headless → browser xterm snapshot.** `PARITY_PASS`: 20 satırın tamamı eşit, alternate buffer eşit, imleç (4,11) eşit, mod farkı sıfır. Fixture normal buffer geçmişi, alternate ekran, truecolor, 256-renk arka plan, CJK wide, combining, emoji, altı çizili/italik/ters, bracketed paste ve application cursor içeriyor.
- [x] **256 KiB'yi aşan çıktı ardından sessiz TUI.** 330.000 baytlık çıktının son 262.144 baytını boş terminale oynatmak referans ekranı kurmuyor (assertion ile sabit); snapshot kuruyor. Ham kuyruk yolu bu yüzden sözleşmeden çıkarıldı.
- [x] **Snapshot bariyerinde yarım dizi.** On iki sekans sınıfında güvenli kesim + bekletilen prefix ile kurulan ekran kesintisiz referansa eşit: tamamlanmamış/alt parametreli/ara baytlı CSI, tamamlanmamış OSC, veri taşıyan DCS, APC, PM, 8-bit C1 girişli CSI ve OSC, charset seçimi, yalnız ESC, tek karakterli ESC. Bekleyen prefix penceresi 4096 bayt.
- [x] **Terminal query cevaplarının tek sahibi.** Headless terminal DA1/DA2/DSR-cursor/DSR-status sorgularının dördüne de cevap üretiyor. Cevap `write()` döndükten sonra, write callback'inden önce geliyor — istemcide senkron bayrakla ayırmak çalışmıyor. Seçilen yol sunucuda sorgu ayıklama: ayıklanmış akışla kurulan ekran tam akışla kurulana birebir eşit, tarayıcı sıfır otomatik cevap üretti, gerçek kullanıcı girdisi geçmeye devam etti.
- [x] **Snapshot boyutu ve chunk'lama.** İki katmanlı attach ölçüldü: dolu 1000 satırlık scrollback'te yalnız-ekran 3.8 KB / 2.8 ms, tam scrollback 126 KB / ~11 ms. Scrollback maliyeti doğrusal (200/500/1000/2000 satır → 28/65/126/248 KB). Attach varsayılanı ekran katmanı.
- [x] **32 sentetik terminal yükü.** Etkileşimli profil: RSS 64 MB, write p95 1.4 ms, event-loop p95 5.6 ms. Yoğun profil ~8.8 MiB/s: RSS 84 MB, write p95 5.2 ms, event-loop p95 5.6 ms (max 20.6 ms), backpressure olayı 0. Kapasite tavanı 32 korundu.
- [x] **Yavaş tüketici ve üretici baskısı.** Run başına bekleyen write high-water eşiğiyle sınırlanıyor; eşik aşılınca ilgili PTY pause edilir. Ölçümde eşik tetiklenmedi, mekanizma script'te uygulanmış durumda.

**Ölçülmemiş ve bilinçli olarak G4'e bırakılanlar:** piksel/font render'ı, ligature davranışı, WebGL ve canvas renderer farkları, paste/mouse/IME etkileşimi. Bunlar buffer durumu eşitliğini değiştirmez ve mimari kararı yeniden açmaz.

Worker write callback'i sürerken attach/resize/exit/restart sıralaması ve snapshot format/sürüm hatası davranışı **uygulama testidir** (G3); tasarım sözleşmesi spec §4'te yazılıdır.

## G2 — Gerçek CLI ilk kullanım ve konuşma akışı (destek kapısı) — **kısmen ölçüldü**

Ortam: Claude Code 2.1.269, Codex CLI 0.154.0, Gemini CLI 0.59.0, gerçek PTY (node-pty, 100×30), temizlenmiş env, Linux. **İnsan onayı gerektiren adımlar ajan tarafından verilmedi ve verilmiş gibi yazılmadı.**

Ölçülenler:

- [x] **Yeni klasörde güven kapısı — üçünde de var.** Claude: “Is this a project you trust?”; Codex: “Do you trust the contents of this directory?”; Gemini: “Do you trust the files in this folder?” (ayrıca “üst klasörü güven” seçeneği sunuyor). Güven kaydı mutlak yola bağlı olduğundan her yeni worktree yeniden sorar. Üçü de onay beklerken tam sessiz kalıyor (11–18 sn gözlendi), yani `idle` sinyali doğru çalışıyor ama “bekliyor” anlamı taşımıyor.
- [x] **Etkileşimli seçiciler çalışıyor.** `claude --resume` arama kutulu “Resume session” listesi; `codex resume` “Resume a previous session” listesi ve **varsayılan Cwd filtresi** ile açılıyor. İkisi de AgentDeck'in kimlik üretmesini gerektirmiyor. V0'ın varsayılan devam yolu bu.
- [x] **Bilinmeyen kimlikle resume temiz hata veriyor.** `claude --resume <bilinmeyen-uuid>` etkileşimli TUI'de de `No conversation found with session ID` + exit 1. Sessiz yeni konuşmaya düşmüyor.
- [x] **Bayrak çakışması doğrulandı.** `gemini --session-id <uuid> --session-file <path>` CLI tarafından reddediliyor (`mutually exclusive`, exit 1). Uygulamanın hiçbir bayrak enjekte etmemesi kararının somut gerekçesi.

Ek olarak ölçülenler (ikinci tur):

- [x] **Kart preview'ı gerçek TUI çıktısında okunabilir.** Üç CLI'ın gerçek PTY çıktısı headless ekran modelinden geçirildi; üçünde de önizleme kelime ve boşluk olarak okunabilir çıktı, yapışık öbek sıfır ([script](../research/preview-readability-probe.cjs)). Naif ANSI temizliği Claude ve Codex'te bozuluyor, Gemini'de bozulmuyor — Gemini kutu içine gerçek boşlukla yazdığı için. Yani naif yöntem *her zaman* değil, *çoğu zaman* bozuk; ekran modeli hepsinde doğru.
- [x] **LaunchPolicy izin listesi uygulanabilir.** Referans uygulama 27 vakada doğrulandı ([script](../research/launch-policy-probe.cjs)): yalnız argümansız literal `claude`/`gemini`/`codex` yönetilen; `gemini --session-file`, `--list-sessions`, `claude --from-pr`, `codex resume`, quote içi `resume`, `--` sonrası prompt, env öneki, wrapper, mutlak yol, pipeline, expansion, newline ve bileşik komutların tamamı kabuk yoluna gidiyor. Doğrulanmamış CLI'da yönetilen eylem açılmıyor.

İnsan gerektiren, **açık kalan** adımlar — bunlar ajan tarafından yapılamaz ve yapılmış gibi kaydedilmemelidir. Hepsini tek komutla yürüten betik: [`g2-human-acceptance.sh`](../research/g2-human-acceptance.sh).

- [ ] Gerçek worktree'de trust/auth kullanıcı tarafından tamamlanır; dosya okuma/yazma ve küçük test komutu çalışır.
- [ ] Onay ekranından önce/sonra stop; transcript oluşmadan çıkış; aynı Session'da tekrar çalışır, worktree içindeki iş korunur.
- [ ] Onay sonrası konuşma gerçekten oluşuyor mu, ve AgentDeck'in ürettiği kimlikle geri açılabiliyor mu? **Her CLI+sürüm için ayrı sonuç gerekir.** Bu geçmeden o CLI için yönetilen kimlik açılmaz.
- [ ] Gemini'de auth gerektiren her yol; bu makinede hesap `IneligibleTierError` verdiği için ölçülemedi.
- [ ] Bayraklı komutların **gerçek CLI'a** uçtan uca iletimi: `gemini --session-file`, `--list-sessions`, `claude --from-pr`, quote içi `resume`, `--` sonrası prompt, env/pipeline/wrapper. (Sınıflandırma tarafı yukarıda kapandı; kalan CLI'ın kendi kabulü.)
- [ ] `.bashrc` erken çıkışı, nvm PATH, `environment.json` yenilemesi, bozuk/izinsiz env dosyası, parent-agent işaretçilerinin temizlenmesi — bunlar daemon uygulanınca test edilebilir.
- [ ] Gerçek TUI preview'ının **üründe** okunabilirliği (ölçüm kanıtı var, ürün entegrasyonu yok).

**Kapının V0 üzerindeki etkisi:** bu kutular işaretlenene kadar yönetilen kimlik hiçbir CLI için açılmaz. Ürün yine de çalışır — literal komut ve CLI'ın kendi seçicisi V0'ın devam yoludur. Betik sonucu `docs/research/g2-results-<tarih>.md` olarak yazar; kutular o dosyaya bakılarak işaretlenir.

## G3 — Dosya, yaşam döngüsü ve kalıcılık (ürün kabulü) — **3/10 kapandı**

Ortam: Node 22.19.0, Linux, gerçek node-pty ve gerçek `git`. Kanıt: depodaki otomatik test paketi (`npm test` — 87 test, `node:test` + tsx). Her madde altındaki test adları o maddeye bakan assertion'ları taşır; kutu ancak maddenin **bütün** cümleleri ölçüldüğünde işaretlendi. Uygulanan dilim [spec §8/1](agentdeck-v0.md), sınırları [ADR 0007](../adr/0007-slice-1-implementation-boundaries.md). Terminal temsili (§8/3), yönetilen kimlik (G2) ve arşiv/kademeli silme (§8/4) bu dilimde yoktur; bu yüzden onlara değen maddeler açık kaldı.

- [x] **Eski ama geçerli state yedeği + yeni kirli orphan worktree: yalnız bildirilir, hiçbir dosya silinmez. Bozuk/yok/yeni şema aynı güvenli davranışı korur.** `store.test.ts`: "state yok ama yönetilen worktree duruyorsa durur; hiçbir dosya silinmez", "bozuk state yazmadan durur ve dosyayı olduğu gibi bırakır", "daha yeni şema durur", "okunamayan state durur", "tanınmayan kayıt şekli durur; kayıt sessizce düşürülmez", "legacy agent/status kaydı yedekle birlikte migrate edilir". `orphans.test.ts`: "keşif hiçbir dosyaya dokunmaz", "symlink izlenmez, atlandığı bildirilir", "giriş/süre bütçesi aşılırsa tarama kesik işaretlenir", "okunamayan dizin eksik keşif olarak bildirilir". `api.test.ts`: "bozuk kalıcı kayıtla daemon açılmaz ve dosyaya dokunmaz", "kayıtsız çalışma kopyaları salt okunur biçimde listelenir" (kayıtlı oturumun kopyası yetim sayılmaz, yetim dosyası korunur).
- [ ] Sinyal gönderilmiş ama grup yaşıyor; lider çıkmış çocuk kalmış; stop timeout; eski expectedRunId; eşzamanlı create/restart/delete/archive. Hatalı durumda yeni Run veya silme başlamaz.
    - Ölçülen: `stop.test.ts` altı vaka (grup çoktan gitmiş; SIGHUP ile ölen; SIGHUP yetmeyip SIGKILL; lider çıkmış grup yaşıyor; grup hiç ölmüyor → `verified:false`; lider hiç çıkmıyor → timeout başarı değil). `sessions.test.ts`: "SIGHUP yetmeyen grup SIGKILL ile doğrulanarak durdurulur", "lider çıkıp çocuk kaldığında grup izlenir ve durdurma onu da temizler" (gerçek PTY, `kill(-pid,0)` ile doğrulandı), "canlı Run varken ikinci Run açılamaz". `api.test.ts`: "eski expectedRunId ile gelen stop yeni Run u etkilemez", "aynı oturumda süren mutation ikinciyi 409 ile reddeder", "lider çıkıp çocuk kalsa da silme grubu doğrulanmış biçimde durdurur".
    - Açık: `archive` eylemi yok (§8/4). SIGKILL'e dirençli gerçek bir süreç grubu çekirdekte kurulamadığı için timeout yolu yalnız sahte grupla ölçüldü; gerçek uninterruptible süreçle ölçülmedi.
- [ ] Spawn başarılı/state commit başarısız ve rollback başarısız; disk-full/izin hatası; crash sırasında iki Run checkpoint'i. Kaynaklar korunur, kısmi sonuç/gerçek exit doğru görünür.
    - Ölçülen: `api.test.ts`: "PTY doğup kayıt yazılamazsa yalnız kendi grubu durdurulur ve kendi worktree i geri alınır" (izin hatası, 503 `persistence`, değişmemiş kendi kaynağı kaldırıldı, yarım worktree kaydı kalmadı, oturum kayda girmedi). `store.test.ts`: "commit başarısızsa yayımlanan state ve disk korunur", "commit copy-on-write: yayımlanan state ancak rename sonrası değişir", "eşzamanlı commit çağrıları sıralanır ve hiçbiri kaybolmaz".
    - Açık: rollback'in de başarısız olduğu yol, gerçek disk-full, ve iki Run checkpoint'i (checkpoint §8/3'te gelir).
- [x] **İki daemon aynı data/farklı port veya symlink alias ile başlayamaz; SIGKILL sonrası kilit bırakılır; port/protokol uyuşmazlığında yabancı süreç öldürülmez.** `lock.test.ts`: "aynı veri dizini için ikinci yazar reddedilir", "symlink alias aynı kilide çözülür", "kilit bırakıldıktan sonra yeniden alınabilir", "farklı veri dizinleri birbirini engellemez". `api.test.ts`: "aynı veri dizini için ikinci daemon açılmaz", "SIGKILL edilen daemon kilidi bırakır" (kilidi ayrı süreçte tutup `SIGKILL` ile öldürerek), "porttaki yabancı servis öldürülmez" (yabancı HTTP servisi portu tutarken daemon açılmıyor, yabancı servis yaşamaya devam ediyor, kilit sızmıyor).
- [ ] Commit edilmiş ve edilmemiş değişiklikler baseCommit görünümünde bulunur; staged/unstaged birbirini geri aldığında status kirli kalır. Shared attribution yok; base bilinmiyorsa uydurulmaz.
    - Ölçülen yalnız kaydın kendisi: `api.test.ts` "oturum açılır, canlı görünür ve gerçek çıkış kaydedilir" `baseCommit`'in çözümlenmiş OID olduğunu, "ortak çalışma kopyasında silme dosyalara dokunmaz" ise shared'de `baseCommit`'in uydurulmadığını (null) doğruluyor. Diff kapsamları §8/4.
- [ ] Archive/unarchive dosyalara dokunmaz; 256 kayıt sınırı arşivleri gizlice silmez; Session silindikten sonra branch proje görünümünde bulunur.
    - Ölçülen: `api.test.ts` "kayıt sınırı dolduğunda create durur ve hiçbir kayıt kesilmez" (256 kayıtla create 409 `capacity`, kayıtlar duruyor) ve "taze onayla silme dosyaları kaldırır ama branch i korur" (silme sonrası branch `git branch --list` ile bulunuyor). Archive/unarchive ve proje branch görünümü §8/4'te.
- [ ] Ignored .env/node_modules, symlink dışı hedef, submodule/nested repo, >128 MiB/>10.000 dosya, 5 sn timeout: onay sınırı aşılırsa token yok. Hiçbir bütçe sessiz truncation ile onay üretmez.
    - Açık: silme onayı bu dilimde dizin kimliği + Git durumuna bağlıdır; içerik fingerprint'i ve bütçeler §8/4'te gelir ([ADR 0007](../adr/0007-slice-1-implementation-boundaries.md)). Önizleme kapsamını `fingerprintScope` alanında söyler.
- [x] **Delete onayı sonrası içerik/Run/dizin değişimi 409; stop sonrası yeniden kontrol; worktree lock/izin hatasında rmSync fallback yok; shared dosyaları korunur.** `api.test.ts`: "onaysız silme reddedilir, onay sonrası içerik değişirse silme durur" (409 `confirmation_stale`, klasör duruyor), "onaydan sonra yeni Run başladıysa silme durur" (runId bağı), "onay başka bir dizine dönen yolda geçersizdir" (dizin kimliği bağı), "worktree kaldırılamazsa rmSync fallback yok; kayıt ve dosyalar korunur" (kilitli worktree ile 500 `worktree_remove_failed`, ajan dosyası ve kayıt yerinde), "ortak çalışma kopyasında silme dosyalara dokunmaz", "branch silme alanı reddedilir" (gövde ve query için 400 `unsupported_field`). Dosya durumu onaydan sonra **ve** doğrulanmış stop'tan sonra yeniden okunuyor.
- [ ] Proje silme kısmi sonuçta kalan Project/Session'ları listeler; branch silme alanı reddedilir; external Git farkı stale gösterilir.
    - Ölçülen: `api.test.ts` "oturumu olan proje gizlice cascade silinmez" (409 `project_has_sessions` + oturum kimlikleri, dosyalar yerinde) ve "branch silme alanı reddedilir". Kademeli proje silme ve external Git stale işaretleme §8/4.
- [ ] Yarım/okunamayan checkpoint ayrı hata verir; legacy history doğru snapshot diye gösterilmez. Terminal yüklemesi/serialize bütçesi aşılırsa açık hata.
    - Açık: checkpoint mekanizması §8/3'te gelir. Bu dilimde canlı olmayan Run için "önceki terminal görüntüsü henüz saklanmıyor" denir; sahte ekran kurulmaz.

## G4 — Bütünleşik kullanıcı akışı (ürün kabulü)

- [ ] Yalnız klavye: proje → oturum → trust/auth → prompt → F6 → diff → başka oturum → tarama → archive. Terminal Escape/Tab/Vim/IME korunur.
- [ ] %200 zoom, dar pencere/drawer, focus geri dönüşü, ekran okuyucu durum duyuruları; polling/reconnect focus çalmaz.
- [ ] 4–8 gerçek oturumda doğru işi bulma, hata fark etme, same-worktree fresh, arşivden bulma; kullanıcı gözlemi kaydedilir.
- [ ] Ağ/401/403/5xx/WS-only kopuş ayrı; stale snapshot sahte orphaned üretmez. Eşit revision activity/preview yenilemesi işlenir.
- [ ] Kayıp create/launch cevabı ve yeni daemon: otomatik ikinci Run yok; requestId payload çakışması doğru reddedilir. Viewer lease devralma ve replay sırasında input kontrolü doğru.

## Devir kuralı

G1 kapandı (12 Eylül 2026). G2 destek kapsamı netleşmesi Wayfinder haritasının kalan açık frontier'ıdır. G3/G4 uygulama kabulüdür; plan haritasının işi ürün kodunu tamamlamak değildir. G1/G2 tamamlandıktan sonra harita kapatılabilir; G3/G4 geçmeden sürüm hazır denmez.

Uygulama durumu (12 Eylül 2026): spec §8/1 dilimi ürün koduna girdi ve G3'ün 3 maddesi otomatik testle kapandı. Kalan 7 madde §8/2–§8/4 dilimlerine ve insan kabulüne bağlıdır. Testlerin geçmesi ürünün doğrulandığı anlamına gelmez: G4'ün tamamı ve gerçek kullanıcı akışı ölçülmedi.
