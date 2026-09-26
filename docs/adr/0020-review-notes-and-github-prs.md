# İnceleme notları ajana gider; PR'lar GitHub CLI ile incelenir

Durum: accepted — 2026-09-26, `feat/pr-review` dalında. [ADR 0011](0011-work-result-slice-implementation.md) içindeki diff sekmesini genişletir; diff okuma sınırları ve kapsamları değişmez.

**Sorun.** Kullanıcı ajanın yaptığı işi Değişiklikler sekmesinde görüyordu ama düzeltme istemek için terminale geçip dosya ve satırı elle yazması gerekiyordu. PR açmak ve bir PR'daki yorumları ajana aktarmak da AgentDeck dışında yapılıyordu. Diff ekranı düz bir liste olduğu için büyük farklarda okunması ve gezinmesi zordu.

**Karar 1 — İnceleme notu ajana yapıştırılan metindir.** Kullanıcı satır, satır aralığı veya dosya için not yazar. Notlar tek bir düz metinde numaralanır: konum (`yol:satır`), yorumlanan kod ve not. Bu metin oturumun canlı Run'ına yapıştırılır. AgentDeck ajana özel bir protokol kullanmaz; metin her ajan CLI'ında ve kabukta aynıdır. Gönderimden önce metin bir pencerede gösterilir ve düzenlenebilir. İsteğe bağlı olarak her not kaydedilir kaydedilmez tek başına gönderilir.

**Karar 2 — Yapıştırma, kullanıcının yapıştırması gibidir.** `POST /api/sessions/:id/input {expectedRunId, text, submit}` metni bracketed paste işaretleri arasında yazar. Satır sonları xterm.js'in paste davranışındaki gibi CR olur, sekme dışındaki kontrol karakterleri atılır. Böylece metin yapıştırmayı erken kapatamaz ve terminale komut dizisi sokamaz. `submit` açıksa Enter 150 ms sonra ayrı yazılır, çünkü yapıştırmayla aynı parçada gelen Enter bazı TUI'lerde metnin parçası sayılır. Gönderim şu durumlarda reddedilir:
- Run canlı değil (409 `not_live`).
- Run değişmiş (409 `run_changed`).
- Terminal bir onay bekliyor (409 `awaiting_approval`). Yapıştırılan metin onay seçimini değiştirebilir.

Metin 128 KiB ile sınırlıdır. Uç, terminal kontrol sahipliğine ([Terminal control](../../CONTEXT.md)) bakmaz: gönderim kullanıcının açık eylemidir, WS istemcisinin tuş girdisi değildir.

**Karar 3 — Notlar tarayıcıda durur.** İnceleme taslağı (notlar, görüldü işaretleri, genel not) oturum kimliğiyle `localStorage`'da tutulur, daemon'a yazılmaz. Taslak kullanıcının o anki incelemesidir; Session kaydının parçası değildir ve silme onayına girmez. Okunamayan kayıt boş taslakla açılır. Bir not, yazıldığı farkın (`work`, `uncommitted`, `pr:<n>`) satır numarasına ve kod metnine bağlanır. Fark değişince önce aynı numara ve metin, sonra aynı metnin en yakın satırı aranır. Bulunamazsa not "eskimiş" işaretlenir ama silinmez. Görüldü işareti dosya farkının özetine bağlıdır; fark değişince düşer.

**Karar 4 — GitHub bağlantısı kullanıcının `gh` oturumudur.** AgentDeck token okumaz, saklamaz ve istemez. Bütün GitHub işleri `gh` alt süreciyle, çalışma alanındaki deponun dizininde yapılır. Etkileşimli istem kapalıdır, çağrı 20 sn ile sınırlıdır. `gh` yoksa, oturum açılmamışsa veya uzak depo GitHub değilse durum alanında bildirilir; uç hata fırlatmaz. Uçlar:
- `GET /api/sessions/:id/github`: depo, varsayılan branch, güncel branch ve bu branch'in PR'ı (açık olan önceliklidir).
- `GET /api/sessions/:id/github/pulls`: açık PR'lar (en çok 50).
- `GET /api/sessions/:id/github/pulls/:n`: PR özeti, GitHub'daki birleşik fark (1 MiB'ta kesilir, işaretlenir), satır yorumları ve satıra bağlı olmayan konuşma.
- `POST /api/sessions/:id/github/pulls`: güncel branch'i `origin`'e gönderir, sonra `gh pr create` ile PR açar. Ayrık HEAD'de ve hedefle aynı branch'te reddedilir.
- `POST /api/sessions/:id/github/pulls/:n/review`: notları tek bir `COMMENT` incelemesi olarak yayımlar. Onay veya değişiklik isteği gönderilmez.

`repo` parametresi çalışma alanının depo taramasında yoksa 404 döner. Arayüz GitHub işlerini yalnız git projelerinde (tek depo) sunar; klasör projesinin alt depolarında PR incelemesi yoktur.

**Karar 5 — GitHub yorumları ajana notla iletilir.** PR'daki satır yorumu ve yanıtları satırın altında gösterilir. "Ajana iletilecek notlara ekle" onları yazar adıyla taslağa ekler. Satıra bağlı olmayan konuşma panelde listelenir ve aynı biçimde eklenebilir. GitHub'da yayımlama yalnız kullanıcının kendi, o PR'ın farkında satıra bağlı notlarını kapsar. İletilen GitHub yorumları geri yayımlanmaz.

**Karar 6 — İnceleme ekranı.** Üç sütundan oluşur:
- Solda dosya ağacı. Tek çocuklu klasörler birleşiktir, filtre ve görüldü işareti vardır.
- Ortada dosyalar. Liste ağaçla aynı sıradadır. Dosya başlıkları yapışkandır. Birleşik veya yan yana düzen seçilebilir. Eşlenen silme/ekleme satırlarında kelime düzeyinde vurgu yapılır. 1500 satırı aşan dosya kapalı açılır.
- Sağda notlar paneli.

`j`/`k` dosyalar arasında gezer, `v` görüldü işaretler. Bu tuşlar yazı alanında ve açık pencerede çalışmaz. Tercihler (düzen, sarma, ağaç, panel, anında gönderim, Enter) bütün oturumlarda ortaktır.

Bilinen sınırlar:
- Sözdizimi renklendirmesi yoktur. Kelime düzeyindeki vurgu okunurluğun büyük kısmını karşılar.
- Hunk'lar arasındaki bağlam genişletilemez. Bunun için dosya içeriğinin okunması gerekir.
- Uygulama, ajan CLI'ının bracketed paste modunu açtığını varsayar. Claude Code, Codex, Gemini CLI ve güncel bash açar. Açmayan bir programda işaretler metin olarak görünür.
- Taslak başka tarayıcıya veya profile taşınmaz.

Doğrulama: `npm test`, `npm run typecheck`, `npm run test:browser`. `tests/browser/review.mjs` şunları sınar: izole oturumun farkı, satır ve aralık notu, dosya notu, görüldü işareti, yan yana düzen, önizlemeli gönderim, sahte ajanın aldığı metin ve Enter, yeniden açılışta taslağın korunması. Sahte `gh` ile de PR seçimi, GitHub yorumunun iletilmesi, yalnız kullanıcı notunun yayımlanması ve kaynaklar arası atlama denenir. Gerçek GitHub'a karşı ve gerçek ajan CLI'larıyla kullanıcı kabulü yapılmadı.
