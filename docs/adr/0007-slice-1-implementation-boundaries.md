# Güvenilir tek Session dilimi uygulandı ve sınırları yazıldı

Durum: accepted — 2026-09-12. Kapsam: [spec §8/1](../specs/agentdeck-v0.md), kanıt [doğrulama kapıları](../specs/agentdeck-v0-validation-gates.md).

Uygulama sırasının ilk dilimi ürün koduna girdi: şema 2 ve yedekli doğrulanmış migrate, tek yazar kilidi, Session başına lifecycle mutasyon kilidi, common Git dizini başına serileştirme, requestId defteri, runId'li Run modeli, doğrulanmış durdurma, dosya koruma ve salt okunur yetim keşfi. Kalıcı kayıt artık canlılık tahminiyle ezilmez; `live` yalnız yeni PTY doğduktan sonra yazılır; gözlenen çıkış kalıcıdır; bilinmeyen ölüm saati/kodu null kalır.

Durdurma iki ayrı şeyi kanıtlar: liderin çıkışı ve grubun boşalması. Lider çıkıp grupta süreç kalırsa bu **kalan süreç grubu** olarak izlenir, çünkü kayıt düşerse kalan çocuklar hiç durdurulamaz ve worktree kilitli kalır. Kalan gruba sinyal göndermeden önce liderin gerçekten toplandığı `/proc` üzerinden doğrulanır: pid yeniden kullanılmışsa yabancı gruba sinyal atılmaz ve durum doğrulanmadı olarak döner. Timeout hiçbir yolda başarı sayılmaz.

İki hüküm bilinçli olarak daraltıldı ve bu daralma sözleşmenin yerine geçmez:

- **Silme onayı** şu an Session id, runId, canonical cwd, dizin kimliği (dev/ino) ve Git durum özetine bağlıdır; 60 sn TTL ve daemon ömrü sınırı vardır. Sözleşmenin ignored dosyalar dahil **içerik fingerprint'i** ve 5 sn / 10.000 dosya / 128 MiB bütçesi §8/4'ün işidir. Önizleme yanıtı kapsamını `fingerprintScope` alanında açıkça söyler; "içerik değişmedi" iddiası bu dilimde üretilmez.
- **Proje silme kademeli değildir.** Oturum kaydı olan proje 409 `project_has_sessions` ile reddedilir ve oturum kimlikleri döner. Sözleşmenin proje onayını Session kümesine ve her onay fingerprint'ine bağlayan kuralı §8/4'te uygulanır; o zamana kadar gizli cascade yapılmaz.

Güncelleme (13 Eylül 2026): iki daraltma da §8/4 diliminde kapandı ([ADR 0011](0011-work-result-slice-implementation.md)). `environment.json` §8/5 diliminde okunur ([ADR 0012](0012-scan-focus-poll-implementation.md)).

Bu dilimde bilinçli olarak yer almayanlar: headless terminal state, güvenli kesim, sorgu ayıklama, iki katmanlı replay ve checkpoint (§8/3 — WS yolu prototip ham tamponu olarak kalır ve doğru ekran temsili diye sunulmaz); yönetilen konuşma kimliği `fresh`/`resume`/`picker` (G2 insan kabul testi geçmeden hiçbir CLI için açılmaz, bu yüzden `lastLaunch` yalnız `command` niyeti üretir); arşivleme, baseCommit diff kapsamları ve korunan branch görünümü (§8/4); `environment.json` (§8/2); terminal control lease.

İki uygulama ayrıntısı kayda geçer: `COLORTERM` izin listesinden miras alınır, miras yoksa uygulama `truecolor` verir — ekran tarafındaki xterm bunu destekler ve daemon'ın başlatıldığı ortam belirleyici olmamalıdır. `AGENTDECK_DATA_DIR` veri dizinini geçersiz kılar; testler ve ayrı örnekler için gereklidir ve tek yazar kilidi canonical yola bağlı olduğu için alias'la ikinci yazar doğurmaz.
