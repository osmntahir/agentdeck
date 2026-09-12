# İki incelemenin karar revizyonuna dönüşümü

Tarih: 2026-09-12 (revizyon 2 + doğrulama turu). Kaynaklar: [ilk inceleme](2026-09-12-v0-decisions-review.md), [bağımsız inceleme](2026-09-12-v0-independent-review.md). Bu iki rapor tarihli kanıttır ve **içerikleri değiştirilmez**; ilk turda yeniden numaralanan ADR adları raporların gövdesine yazılmıştı, bu geri alındı ve her raporun başına numara eşleme notu konuldu. Güncel karar [spec revizyon 2.1](../specs/agentdeck-v0.md), açık kabul kapıları [doğrulama kapıları](../specs/agentdeck-v0-validation-gates.md), gerekçeler [ADR'ler](../adr/0001-worktree-session-branch-lifetimes.md). Bulguların kabul edilmesi her önerilen çözümün otomatik kabul edildiği anlamına gelmez.

## Bulguların tek tek sonucu

1. **Orphan sweep — düzeltildi.** Geçerli eski state dahil startup hiçbir orphan dosyayı silmez. Salt okunur keşif ve yol/Git kayıt bilgisi vardır; V0 otomatik veya UI force temizliği yok. Create rollback yalnız kendi doğrulanmış kaynakları içindir.
2. **Kesilmiş halka ekranı kuramaz — mimari değiştirildi; bariyer mekanizması artık belirli.** Daemon headless terminal state ve snapshot seçildi. İkinci turda bariyer sorunu hem **üretildi** (yarım CSI'de renk kaybı ve `1m` metninin ekrana sızması; yarım OSC'de başlık gövdesinin sızması) hem de **çözüldü**: güvenli kesim + bekletilen prefix aktarımı, dört ardışık devirde kesintisiz referansla eşit ekran verdi. Spec §4 bunu zorunlu iki parçalı mekanizma olarak yazar. Açık kalan: sekans kapsamı (8-bit C1, DCS gövdesi, SOS/PM/APC), terminal-response sahipliği, browser renderer ve yük davranışı — hepsi G1'de. “Ürün testi geçti” denmedi.
3. **Komut blacklist'i — düzeltildi.** V0 yalnız argümansız literal bilinen CLI çağrısına managed launch eylemleri verir. Bütün bayraklı/env/wrapper komutlar aynen çalışır. --session-file/--from-pr gibi yeni seçenekleri takip eden blacklist yok. Destek sürümü doğrulanmadan managed özellik açılmaz.
4. **Restart çıkmazı — sözleşme düzeltildi.** Fresh/repeat/resume/picker ayrı niyet. Fresh yeniden çalıştırmada yeni UUID; resume hata sonrası aynı Session/worktree'de açık fresh veya başka komut. PTY spawn konuşma oluşumunun kanıtı değil. Önceki Run görüntüsü hemen silinmez.
5. **Commit sonrası görünmez iş — düzeltildi.** baseCommit kalıcı, çalışma toplam diff'i ile commit edilmemiş görünüm ayrı. Archive kayıt/worktree'yi tutar. Silinen Session branch'i Git refs üzerinden bulunabilir; uygulama branch silmez.
6. **Idle ve dikkat — çerçeve düzeltildi.** Sessizlik sinyali korunur; “kullanıcı bekliyor” çıkarımı yapılmaz. İlk açılışta trust/auth adımını tamamlamak açık yolculuk, terminal yanında kapatılabilir kısa bilgi. Her idle oturumu hata gibi boyamak yok.
7. **Okunamayan geçmiş — düzeltildi.** Yok, hazırlanıyor, eski ve okunamıyor ayrıdır. Lifecycle genişletilmez. Read error ve checkpoint zamanı görünür; log secret içermez.
8. **Delete kapsam/maliyet — daraltılarak düzeltildi.** V0 branch silme çıkarıldı. Ignored dahil bounded inceleme, gerçek içerik/Run/dizin kimliğine bağlı onay, stop sonrası taze kontrol. Bütçe aşılırsa bypass force yok. Dış dosya yazarıyla atomik FS garantisi verilmez. Büyük bağımlılık klasöründe kullanıcıya yerel temizlik ve yol kopyalama sunulur.
9. **Worktree hazırlığı — düzeltildi.** HEAD kopyasının `.env`, bağımlılık ve port hazırlığı olmadığını ilk akış söyler. Otomatik secret/trust aktarımı veya kurulum yok; gerçek projede kabul senaryosu var.
10. **Trust kapısı — düzeltildi; sonradan üçünde de doğrulandı.** İlk turda yalnız Claude'da doğrudan TUI kanıtı vardı ve genelleme haklı olarak daraltılmıştı. G2 ölçüm turunda Codex (“Do you trust the contents of this directory?”) ve Gemini (“Do you trust the files in this folder?”) için de gerçek PTY kanıtı alındı; üçü de yeni klasörde soruyor ve onay beklerken tam sessiz kalıyor. Yeni klasörde trust/auth gerekebileceği ilk açılışta anlatılır; onay insan eylemi olarak kalır, uygulama otomatik onaylamaz ve güven dosyalarına yazmaz.
11. **Okunamaz preview — düzeltildi ve gerçek CLI çıktısında doğrulandı.** İlk rapordaki “bounded preview korunmalı” endorsement'ı içerik üretimi açısından geri çekildi. Poll/bütçe korunur; preview ANSI silerek değil headless hücrelerden üretilir. Üç CLI'ın gerçek PTY çıktısında ekran modeli okunabilir çıktı (yapışık öbek sıfır). Bir düzeltme: naif ANSI temizliği **her** CLI'da bozulmuyor — Claude ve Codex kelimeleri sütun konumlandırmasıyla yazdığı için bozuluyor, Gemini kutu içine gerçek boşlukla yazdığı için bozulmuyor. Bağımsız raporun “ana ekranda çöküyor” ifadesi ölçülen üç CLI'ın ikisi için doğru, üçü için değil; karar yine de değişmiyor çünkü ekran modeli üçünde de doğru.
12. **Ham bayt/JSON — kavram düzeltildi ve sınır ölçüldü.** UTF-8 çözülmüş string kanalı seçildi; keyfi binary kayıpsızlığı vaat edilmez. UTF-8 text payload ve JSON wire bütçeleri ayrı. Ham baytın JSON'da taşınması teknik olarak base64 ile mümkündür; çelişki evrensel imkânsızlık değil, eski sözleşmenin bunu seçmemesiydi. İkinci turda sınır ölçüldü: bir kod noktasını parça sınırında bölmek ekranda replacement karakteri üretiyor, bu yüzden spec artık kod noktası **ve** surrogate çifti bölmeyi yasaklar ve node-pty'nin yalnız PTY okuma sınırını koruduğunu söyler.
13. **Tek replay/frame — düzeltildi.** replay-start/chunk/end; reset yalnız start; input ancak end ve parser write completion sonrası. “Tüm replay” mantıksal snapshot, tek ağ frame'i değildir. Büyük replay kademeli gönderilir; wire queue bounded.
14. **Daemon env — düzeltildi, genelleme daraltıldı.** Temel env izin listesi, parent ajan işaretçileri temizliği, her Run login profili ve özel kullanıcı environment.json. Başka kabuktaki export'u uzun yaşayan daemon'ın kendiliğinden görmesi vaat edilmez. Login profilinin PATH'i hiç yenileyemeyeceği de söylenmez; profil içeriğine bağlıdır.
15. **Codex kimlik yolu — değerlendirildi, V0 otomatik taramasına bilinçli hayır.** Rollout iç formatı/cwd/en yeni dosya kesin Run sahipliği sağlamaz. Cwd aynı Session'daki ardışık konuşmalar için aynıdır; dış süreçler de kullanabilir. Belgeli CLI resume seçicisi ve açık id kullanıcı eylemi sunulur. Araştırma yolu “imkânsız” diye kapatılmaz, future integration olarak bırakılır. Bulunamama otomatik fresh fallback değildir.

## Karar tutarlılığı

- ADR numaraları tekilleştirildi: 0001 worktree, 0002 Command, 0003 launch/restart, 0004 terminal state, 0005 degraded, 0006 baseCommit/archive.
- “Destroy atomiktir”, “her restart resume”, “ham halka doğru ekran”, “ANSI temizlenmiş preview”, “sessiz boş read error”, “tüm env mirası” ve “branch silme” eski hükümleri yürürlükten kaldırıldı.
- State schema ve WS protocol revizyon 2 oldu; legacy migration sadece bilinen şemaları kabul eder. Başlangıç OID veya konuşma kimliği uydurulmaz.
- Mevcut runtime README'si ayrı etiketlendi. Araştırma deneyleri tekrar edilmiş gibi yazılmadı; iki orijinal raporun sonuçları yeni karar diye kullanılmamalı.
- Güncel normatif spec GitHub devir issue gövdesinde de yayımlanır; geçmiş yorumlar düzeltme notuyla tarihçe olarak kalır. Harita ve devir G1/G2 kapanana kadar açık tutulur.

## Bu tur gerçekten doğrulananlar

- Kurulu node-pty tipi varsayılan utf8 ve encoding:null ayrımını doğruladı.
- @xterm/headless 6.0.0 + addon-serialize 0.14.0 ile 330.000 bayt çıktı fixture'ında tail replay başarısızlığı ve snapshot ekran/cursor/mode eşitliği assertion ile doğrulandı; [script ve sonuç](../research/terminal-state-validation.md).
- Resmi Codex CLI sayfası resume özelliği/seçiciyi belgeliyor; lokal rollout dosyaları ürünün otomatik eşleme API'si kabul edilmedi. [Resmi CLI belgesi](https://learn.chatgpt.com/docs/codex/cli)
- İkinci turda bariyer deneyi eklendi: yarım CSI/OSC'de snapshot bozulması üretildi, güvenli kesim + bekletilen prefix ile dört ardışık devirde ekran eşitliği assertion ile doğrulandı, ve bölünmüş kod noktasının bozulması gösterildi. Script bu iddiaların hepsini `assert` ile zorlar.
- Bu deneylere dayanarak gerçek CLI, browser veya performans kapıları geçmiş sayılmadı. Sekans kapsamı, terminal-response sahipliği ve yük davranışı açıkça G1'de tutuldu.

## İkinci doğrulama turunda düzeltilenler

Revizyon 2 taslağında kalan kusurlar:

- **ADR provenance'ı kendine referans veriyordu.** 0004 “eski 0004'ü değiştirir”, 0005 “eski adı 0005” diyordu; doğru öncüller `0002-scrollback-session-record.md` ve `0003-degraded-is-derived-overlay.md` olarak yazıldı.
- **Tarihli raporların gövdesi yeniden yazılmıştı.** İlk incelemenin belge bazlı bulguları ve bağımsız incelemedeki bir issue yorumu alıntısı yeni ADR adlarına çevrilmişti; bu, ilk raporun “iki 0002 ve iki 0003 var” bulgusunu kendi listesiyle çelişir hale getiriyordu. Orijinal adlar geri kondu, eşleme notu başlığa taşındı.
- **“256 KiB kuyruk yardımcı olabilir” belirsizliği.** Uygulanamaz bir “olabilir” yerine karar: V0'da ayrı ham çıktı halkası yoktur; ekranın tek kaynağı terminal state, kalıcılığın tek biçimi checkpoint'tir.
- **Parser bariyeri açık soru olarak bırakılmıştı.** Artık belirli, ölçülmüş ve zorunlu mekanizma.
- **32 live PTY sayısı dayanaksız kalmıştı.** Eski bellek hesabının geçersiz olduğu yazılmış ama sayı korunmuştu; sayı G1 ölçümüne normatif olarak bağlandı ve ürün vaadi 4–8 oturum olarak ayrıldı.
- **Eylem modelinde yinelenen düğme.** `lastLaunch.mode = fresh` iken “Yeniden çalıştır” ile “Aynı dosyalarla yeni konuşma” aynı sonucu veriyordu; collapse kuralı ve birincil eylem sırası yazıldı. Hiçbir eylem otomatik çalışmaz.
- **Sözlük eksikleri.** Spec'in normatif olarak kullandığı Launch intent, LaunchPolicy, Snapshot ve Checkpoint terimleri `CONTEXT.md`'ye eklendi.
- **Araştırmadaki mutlak ifade.** Gemini için “hiçbir şekilde” ifadesi ölçülen sürüm/yola bağlandı.

## Değişim sınırı

Ürün kodu, ürün bağımlılıkları, CLI trust/auth ayarları ve kullanıcı reposundaki işler değiştirilmedi. Çıktı doküman revizyonu ve kanıt script'idir. Doküman tutarlılığı test edilebilir; “hiç bug veya yan etki kalmayacak” ancak uygulama/test/gerçek kullanım kanıtıyla yaklaşılabilecek bir hedeftir, bu revizyonun verdiği garanti değildir.
