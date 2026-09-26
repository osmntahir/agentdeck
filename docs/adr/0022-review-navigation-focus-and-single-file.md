# İnceleme gezinmesi: tek dosya, görüldü akışı ve odak modu

Durum: accepted — 2026-09-26, `feat/pr-review` dalında. [ADR 0020](0020-review-notes-and-github-prs.md) Karar 6'daki inceleme ekranını genişletir.

**Sorun.** Büyük bir PR'da bütün dosyalar alt alta tek uzun sayfada duruyordu. "Görüldü" işareti dosyayı kapatıyor ama sıradakine geçmiyordu. Hangi dosyanın kaldığı ancak ağaçtaki işaretlere bakarak anlaşılıyordu. Uygulamanın kenar çubuğu ve üst çubuğu okuma alanını daraltıyordu. İncelemeye dönünce en başa düşülüyordu.

**Karar 1 — Tek dosya ve tüm dosyalar iki ayrı gösterimdir.** "Tek dosya" modunda yalnız seçili dosya görünür. Ağaçtan seçmek, `J`/`K` ve alttaki yapışkan gezinme çubuğu dosya değiştirir. Çubukta önceki dosya, sıra (`3 / 12`), "Görüldü, sıradaki" ve sonraki dosya vardır. Bu modda dosya kapatılamaz. "Tüm dosyalar" önceki alt alta gösterimdir. Seçim bütün oturumlarda ortak tercihtir, `S` ile değişir.

**Karar 2 — Görüldü işaretlemek sıradaki görülmemiş dosyaya götürür.** Kutu, `V` veya çubuktaki düğme dosyayı görüldü işaretler. Ardından görünen sırada bu dosyadan sonraki ilk görülmemiş dosya açılır; sonda baştan aranır (`nextUnviewed`). İşareti kaldırmak yerinde bırakır. `N` görüldü işaretlemeden sıradaki görülmemiş dosyaya gider. Bütün dosyalar görülünce üstte bir kart çıkar: bekleyen not sayısı, "Notları ajana gönder" ve "Görüldü işaretlerini sıfırla". Ağaçta bütün dosyaları görülen klasör ✓ ile işaretlenir.

**Karar 3 — Görülenler gizlenebilir.** "Görülenleri gizle" (`H`, ağaç başlığındaki düğme) görülen dosyaları listeden ve ağaçtan çıkarır. Tek dosya modunda ekrandaki dosya, kullanıcı ilerleyene kadar kaybolmaz; aksi hâlde işaretlediği anda gözünün önünden kaybolurdu. Tüm dosyalar modunda ağaç başlığında hepsini kapatma ve açma düğmeleri de vardır. `X` bulunulan dosyayı kapatır veya açar.

**Karar 4 — Kaldığın yerden devam edilir.** Açılan her dosya, kaynak başına (`work`, `uncommitted`, `pr:<n>`) inceleme taslağına yazılır. Kaynak o açılışta ilk kez yüklenince bu dosya açılır. Taslakla aynı yerde, tarayıcıda durur.

**Karar 5 — Odak modu uygulama kabuğunu gizler.** Düğme veya `F` şunları yapar:
- Kök öğeye `data-review-focus` yazar. Bu işaret kenar çubuğunu, uygulamanın üst çubuğunu ve proje PR sayfasının başlığını gizler.
- Pencereyi Fullscreen API ile tam ekrana alır. API yoksa veya reddedilirse yalnız kabuk gizlenir.

İnceleme çubuğu, dosya ağacı ve not paneli kalır. Proje PR incelemesinde gizlenen PR seçicinin yerine çubukta önceki/sonraki PR düğmeleri çıkar; `[` ve `]` de aynı işi yapar. Odaktan iki yolla çıkılır:
- Tam ekrandan çıkış (tarayıcının Esc'i) odağı da kapatır.
- Tam ekran yoksa Esc yakalama aşamasında tutulur ve uygulamaya iletilmez. Aksi hâlde aynı tuş geldiğin sayfaya da döndürürdü.

İnceleme ekranı kapanınca işaret ve tam ekran geri alınır.

**Karar 6 — Kısayollar tek yerde listelenir.** `?` veya çubuktaki düğme bütün inceleme kısayollarını gösterir. Listenin altında kısa bir hatırlatma satırı durur. Kısayollar yazı alanında, açık pencerede ve menüde çalışmaz. Değiştirici tuşla (Ctrl, Alt, Meta) basılınca da çalışmazlar; uygulama kısayollarıyla çakışmazlar. Araç çubuğuna yer açmak için "Birleşik / Yan yana" seçimi açıklamalı iki simgeye indi.

Bilinen sınırlar:
- Kaldığın yer yalnız dosya düzeyindedir, dosya içindeki kaydırma konumu tutulmaz.
- Tam ekran isteği kullanıcı hareketi ister. Düğme ve `F` bunu sağlar, program yoluyla açılış desteklenmez.

Doğrulama: `npm test` (`nextUnviewed`), `npm run typecheck`, `npm run test:browser`. `tests/browser/review.mjs` şunları sürer:
- Tek dosya modu, `J`/`K`.
- `V` ile üç dosyayı her seferinde başka bir görülmemiş dosyaya geçerek bitirme.
- "Bütün dosyalar görüldü" kartı, tamamlanan klasör ✓'i ve sıfırlama.
- Görülenleri gizlemenin listeyi ve ağacı daraltması.
- Odak modunda kabuğun gizlenmesi ve Esc'in yalnız odaktan çıkarması.
- Kısayol penceresi.
- Yenilemeden sonra kaldığın dosyanın açılması.
