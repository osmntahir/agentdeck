# AgentDeck V0 doğrulama kapıları

Tarih: 2026-09-12. Tasarım sözleşmesi [spec revizyon 2](agentdeck-v0.md). Buradaki kutular **ürün test sonucu değildir**. Kapı sahibi sonuç/komut/sürüm/ortam ve varsa fixture bağlantısını kaydetmeden kutu işaretlenmez. İnsan trust/auth onayı ajan tarafından verilmiş gibi yazılmaz.

## G1 — Terminal temsili ve protokol (tasarım devir kapısı)

Sentetik headless deneyi mevcut ve bariyer mekanizması dahil assertion'larla geçiyor; [kanıt ve tekrar yönergesi](../research/terminal-state-validation.md). Tam ürün uygulamasından önce aşağıdaki maddeler seçilen serializer/terminal sürümleri üzerinde çalıştırılmalıdır. Geçmezse ham halka veya resize dürtmesine sessiz fallback yok; terminal kararı yeniden açılır.

- [ ] Headless → browser xterm snapshot: normal ve alternate ekran, renk/stil, cursor, bracketed paste, mouse/application cursor modları, Unicode/wide/combining karakter ve resize.
- [ ] 256 KiB'yi aşan çıktı ardından sessiz TUI: A→B→A, Terminal→Diff→Terminal ve sıfırdan ikinci istemci. Ekran/girdi karşılaştırılır.
- [ ] Snapshot bariyerinde yarım CSI, OSC, DCS, UTF-8 ve split surrogate; tamamlama sonrası ekranlar aynı. **Yöntem seçildi ve dar fixture'da doğrulandı** (güvenli kesim + bekletilen prefix aktarımı, [kanıt](../research/terminal-state-validation.md)); burada doğrulanacak olan kapsamdır: 8-bit C1 kontrolleri, gömülü veri taşıyan DCS gövdesi, SOS/PM/APC, alt parametreli CSI ve bekleyen prefix üst sınırının aşıldığı durum. Public API'yle sürdürülebilirliği ve xterm sürüm yükseltmesinde davranışın korunduğu kaydedilir.
- [ ] Terminal query cevaplarının tek sahibi: istemci yokken, bir writer+bir viewer varken, replay sırasında DA/DSR sorgusu. Eksik/çift cevap yok; terminal-generated input lastActivity'yi yanlış ileri almaz. Browser otomatik yanıtlarını kullanıcı input'undan ayırma yöntemi kanıtlanır.
- [ ] Snapshot >32 KiB ve >1 MiB: chunk indeksleri, JSON wire escape genişlemesi, eksik/tekrarlı chunk, replay-end write callback bariyeri, S sonrası output/resize sıralaması.
- [ ] Worker write callback'i sürerken attach/resize/exit/restart; eski run callback/flush yeni Run'a dokunmaz. Snapshot format/sürüm hatası sahte ekran üretmez.
- [ ] 32 sentetik PTY, 256 kayıt, 24 görünür kart, tek browser terminal: normal yük ve aggregate 10 MiB/s output, burst ve 60 sn steady-state. RSS, heap, worker kuyrukları, event-loop delay, input→paint ve attach gecikmesi raporlanır.
- [ ] Başlangıç performans hedefi: normal etkileşimli 4–8 oturumda p95 input→paint <100 ms, tipik checkpoint ile p95 attach <500 ms; yoğun çıktıda kontrol endpoint p95 <250 ms. Bu hedefler ölçülmüş garanti değildir. Test makinesi ve output profili kaydedilir; kuyruklar sınır içinde kalmalı ve steady-state RSS sınırsız büyümemeli.
- [ ] **Kapasite kararı:** yukarıdaki ölçüm 32 live PTY'de hedefleri karşılamıyorsa V0 limiti ölçülen değere indirilir ve spec §4 güncellenir. 32 sayısı bu kapı kapanana kadar ölçülmemiş tavandır; kapasite iddiası olarak kullanılmaz.
- [ ] Yavaş viewer yalnız kendisi ayrılır. Headless tüketim baskısı yalnız ilgili PTY'yi pause/resume eder; pause kalıcı kilitlenmez, control/stop çalışır. Worker ölümü görünür, canlı dosya işi otomatik silinmez.

G1 sonuçlanmadan “uygulamaya tamamen hazır” devir kapanmaz. Bu, bilinen bir tasarım boşluğudur; tamamlanmış ürün testi diye ertelenmez.

## G2 — Gerçek CLI ilk kullanım ve konuşma akışı (destek kapısı)

Her ilan edilen CLI/sürüm için ayrı sonuç gerekir. Mevcut araştırma sürümleri adaydır; gerçek kullanıcı auth'ı mevcut değilse destekli resume ilan edilmez, genel Command yolu çalışabilir.

- [ ] Yeni gerçek worktree'de trust/auth kullanıcı tarafından tamamlanır; dosya okuma/yazma ve küçük test komutu çalışır. Mevcut proje trust'ının otomatik devralındığı varsayılmaz.
- [ ] Onay ekranından önce/sonra stop; transcript oluşmadan çıkış; aynı Session'da fresh tekrar çalışır, worktree içindeki iş korunur.
- [ ] Destekli explicit resume aynı konuşmayı sürdürür; bilinmeyen id hata verir; kullanıcı aynı dosyalarla fresh'e geçer. Hata sonrası eski terminal görüntüsü okunur.
- [ ] Codex seçici ve açık id kullanıcı tarafından seçilir; shared/aynı cwd'de çoklu konuşma yanlış otomatik eşlenmez.
- [ ] Bayraklı tüm komutlar aynen iletilir: gemini --session-file, --list-sessions, claude --from-pr, quote içi resume, -- sonrasındaki prompt, env/pipeline/wrapper. Uygulama CLI'ya bayrak eklememiş olmalı; CLI'nın kendi hatası ayrı kaydedilir.
- [ ] Yeni CLI sürümü/executable/PATH değişimi managed capability'yi yeniden doğrular; unsupported bayrak sessizce uygulanmaz. Genel komut kullanımı engellenmez.
- [ ] `.bashrc` erken çıkışı, profil değişikliği, nvm PATH, environment.json yenileme, bozuk/izinli olmayan env dosyası, parent-agent işaretçilerinin temizlenmesi. Hiçbir değer/anahtar log'a düşmez.
- [ ] Gerçek TUI ekranından çıkarılmış kart preview kelimeleri/boşlukları okunabilir; ilk onay açıklaması akışı kapatmaz; idle “bekliyor” diye sunulmaz.

## G3 — Dosya, yaşam döngüsü ve kalıcılık (ürün kabulü)

- [ ] Eski ama geçerli state yedeği + yeni kirli orphan worktree: yalnız bildirilir, hiçbir dosya silinmez. Bozuk/yok/yeni şema aynı güvenli davranışı korur.
- [ ] Sinyal gönderilmiş ama grup yaşıyor; lider çıkmış çocuk kalmış; stop timeout; eski expectedRunId; eşzamanlı create/restart/delete/archive. Hatalı durumda yeni Run veya silme başlamaz.
- [ ] Spawn başarılı/state commit başarısız ve rollback başarısız; disk-full/izin hatası; crash sırasında iki Run checkpoint'i. Kaynaklar korunur, kısmi sonuç/gerçek exit doğru görünür.
- [ ] İki daemon aynı data/farklı port veya symlink alias ile başlayamaz; SIGKILL sonrası kilit bırakılır; port/protokol uyuşmazlığında yabancı süreç öldürülmez.
- [ ] Commit edilmiş ve edilmemiş değişiklikler baseCommit görünümünde bulunur; staged/unstaged birbirini geri aldığında status kirli kalır. Shared attribution yok; base bilinmiyorsa uydurulmaz.
- [ ] Archive/unarchive dosyalara dokunmaz; 256 kayıt sınırı arşivleri gizlice silmez; Session silindikten sonra branch proje görünümünde bulunur.
- [ ] Ignored .env/node_modules, symlink dışı hedef, submodule/nested repo, >128 MiB/>10.000 dosya, 5 sn timeout: onay sınırı aşılırsa token yok. Hiçbir bütçe sessiz truncation ile onay üretmez.
- [ ] Delete onayı sonrası içerik/Run/dizin değişimi 409; stop sonrası yeniden kontrol; worktree lock/izin hatasında rmSync fallback yok; shared dosyaları korunur.
- [ ] Proje silme kısmi sonuçta kalan Project/Session'ları listeler; branch silme alanı reddedilir; external Git farkı stale gösterilir.
- [ ] Yarım/okunamayan checkpoint ayrı hata verir; legacy history doğru snapshot diye gösterilmez. Terminal yüklemesi/serialize bütçesi aşılırsa açık hata.

## G4 — Bütünleşik kullanıcı akışı (ürün kabulü)

- [ ] Yalnız klavye: proje → oturum → trust/auth → prompt → F6 → diff → başka oturum → tarama → archive. Terminal Escape/Tab/Vim/IME korunur.
- [ ] %200 zoom, dar pencere/drawer, focus geri dönüşü, ekran okuyucu durum duyuruları; polling/reconnect focus çalmaz.
- [ ] 4–8 gerçek oturumda doğru işi bulma, hata fark etme, same-worktree fresh, arşivden bulma; kullanıcı gözlemi kaydedilir.
- [ ] Ağ/401/403/5xx/WS-only kopuş ayrı; stale snapshot sahte orphaned üretmez. Eşit revision activity/preview yenilemesi işlenir.
- [ ] Kayıp create/launch cevabı ve yeni daemon: otomatik ikinci Run yok; requestId payload çakışması doğru reddedilir. Viewer lease devralma ve replay sırasında input kontrolü doğru.

## Devir kuralı

G1 prototip/uyumluluk yöntemi kanıtı ve G2 destek kapsamı netleşmesi Wayfinder haritasının açık frontier'ıdır. G3/G4 uygulama kabulüdür; plan haritasının işi ürün kodunu tamamlamak değildir. G1/G2 tamamlandıktan sonra harita kapatılabilir; G3/G4 geçmeden sürüm hazır denmez.
