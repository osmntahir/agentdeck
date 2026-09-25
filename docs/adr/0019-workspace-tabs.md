# Çalışma alanı: oturumlar sekme olarak açılır

Durum: accepted — 2026-09-25, `feat/workspace-tabs` dalında. [ADR 0010](0010-terminal-grid.md) içindeki "grid ayrı bir görünümdür, oturumlar ona elle eklenir" kararını değiştirir.

**Sorun.** Kullanıcı GNOME Terminal'deki gibi çalışmak istiyor: sol üstteki + ile yeni sekme açmak, sekmeler arasında geçmek, gerekince sekmeleri yan yana koymak. Önceden bir oturuma tıklamak onu tek oturum görünümünde açıyordu. Yan yana çalışmak için ayrı bir "Terminal grid" görünümüne geçmek gerekiyordu. Böylece aynı işi yapan iki görünüm vardı ve aralarında gidip gelmek gerekiyordu.

**Karar 1 — Sekme bir Session'dır.** Sekmeler bir oturumun içinde açılmaz. Her sekme ayrı bir Session'dır. Onay bekleme, bildirim, konuşma takibi, işe bağlama ve kurtarma zaten Session üzerine kurulu. Oturum içi sekme bunların hepsini ikinci kez kurmayı gerektirirdi. Ayrıca bir sekmedeki ajan onay beklediğinde bunun hangi sekmede olduğu kaybolurdu. Kenar çubuğu bütün oturumların listesidir. Sekmeler yalnız şu an önde tutulanlardır. Sekmeyi kapatmak oturumu durdurmaz.

**Karar 2 — Sekmeler ve grid tek bir çalışma alanıdır.** Eski grid (Dockview) çalışma alanı olur. Kenar çubuğundan, taramadan, paletten, bildirimden veya Alt+rakamla seçilen oturum etkin gruba sekme olarak eklenir ve öne gelir. Oturum zaten açıksa yalnız öne gelir. Başka bir çalışma alanında açıksa o alana geçilir. Yan yana koymanın üç yolu vardır:
- Sekmeyi veya kenar çubuğu satırını bir panelin kenarına sürüklemek.
- Kenar çubuğunda bir satırı başka bir satırın üstüne bırakmak. İki oturum yan yana açılır.
- Menüdeki "Yan yana aç" eylemi.

Orta tık oturumu arka plan sekmesi olarak ekler. Hiç sekme yokken sekme şeridi de yoktur, yalnız + ve bir başlangıç ekranı görünür.

**Karar 3 — Sol üstte +.** + etkin sekmenin projesinde ve işinde, o projede en son seçilen programla yeni bir oturum açar ve onu sekme olarak ekler. Etkin sekme yoksa oturum projesiz açılır (Genel). Yanındaki ok program, proje ve "Yeni oturum…" penceresini sunar.

**Karar 4 — Ayrıntı görünümü.** Önceki tek oturum görünümü kalır. Değişiklikler (diff), önceki Run'lar ve tam başlık için kullanılır. Sekme başlığındaki düğmeden veya "Değişiklikleri incele" eyleminden açılır. Esc ile geldiğin yere dönülür.

**Karar 5 — Kısayollar GNOME Terminal ailesinden.**
- Ctrl+Shift+T: yeni sekme.
- Ctrl+Shift+W: sekmeyi kapat.
- Ctrl+PgUp ve Ctrl+PgDn: çalışma alanında sekmeler arasında dolaşır. Çalışma alanı açık değilken eskisi gibi kenar çubuğu sırasını izler.

Masaüstü uygulamasında Ctrl+Shift+W pencereyi kapatıyordu. Pencereyi kapatma GNOME Terminal'deki gibi Ctrl+Shift+Q'ya taşındı. Ctrl+W ve Ctrl+T kabukta başka işlere yaradığı için alınmaz.

**Karar 6 — Sınırlar.** Gizli sekme xterm ve bağlantı tutmaz. Öne gelince ekranı daemon'dan yeniden kurar. Bu yüzden panel sınırı 8'den 16'ya çıkar. Görünür terminal sayısı grup sayısıyla sınırlıdır. Yalnız öndeki sekmeler "kullanıcı bakıyor" sayılır; arka plandaki sekmenin bildirimi susturulmaz. Yerleşim ADR 0010'daki gibi yalnız istemcide tutulur.

**Değerlendirilen seçenekler.**
- *Oturum içinde sekmeler.* Reddedildi (Karar 1).
- *Tek oturum görünümüne ayrı bir sekme şeridi eklemek, grid'i ayrı bırakmak.* Daha az değişiklik gerektiriyordu. Reddedildi, çünkü sekmeyi yan yana koymak için yine görünüm değiştirmek gerekiyordu.
