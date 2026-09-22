# Klavyeyle hızlı geçiş, komut paleti ve dikkat durumu

Durum: accepted — 2026-09-22, `deneme/tasarim-yenileme` dalında. [ADR 0010](0010-terminal-grid.md) içindeki "Terminal tuşlarına yeni yerleşim kısayolu atanmaz" hükmünü aşağıdaki dar kısayol ailesi için değiştirir.

Kullanıcı birden çok ajanı aynı anda çalıştırıyor ve aralarında fareyle kenar çubuğuna gitmeden geçmek istiyor. Terminal odaktayken klavye PTY'ye aittir; bu yüzden her kısayol ya kabukta anlamsız ya da GNOME Terminal'in sekme kısayollarıyla aynı aileden seçildi.

**Kısayollar.** `Ctrl+Shift+P` her yerde, `Ctrl+K` yalnız terminal dışında komut paletini açar (`Ctrl+K` kabukta satır sonuna kadar siler ve terminale gider). `Alt+1…9` kenar çubuğundaki sıradaki oturuma atlar; tuş `event.code` ile okunur, klavye düzeninden bağımsızdır. `Ctrl+PgUp/PgDn` önceki/sonraki oturuma geçer. `Ctrl+Shift+N` yeni oturum penceresini, grid'de `Ctrl+Shift+Enter` odaktaki paneli büyütür/geri alır. Eşleşme `src/shared/shortcuts.ts` içindedir ve birim testlidir. Olay yakalama aşamasında durdurulur, xterm'e ve PTY'ye hiç ulaşmaz; tarayıcı testi `cat` yankısıyla bunu doğrular. Açık pencere veya menü varken kısayollar çalışmaz. Sıra, ADR 0014'teki kenar çubuğu kuralını izler: yalnız canlı veya kalan süreç grubu olan arşivsiz oturumlar.

**Komut paleti.** Oturumlar (önce onay/yanıt bekleyenler), projeye göre "yeni oturum" ve genel komutlar tek listede, çok kelimeli ve harf sırası korunan eşleşmeyle (`src/shared/fuzzy.ts`) aranır. "Yeni oturum" satırı pencere açmadan proje klasöründe (shared) varsayılan adla Run başlatır; grid açıksa oturum grid'e eklenir ve odak alır. Aramasızken proje başına yalnız son kullanılan program önerilir; son program `localStorage` tercihidir, daemon state'ine girmez.

**Odak.** Klavyeyle gelinen grid paneli, replay hazır olunca terminal odağını alır. Tıklamayla grid'e eklenen panel odağı çalmaz; ADR 0010'daki imleç davranışı değişmez.

**Dikkat durumu.** Daemon'un doğruladığı `attention` (onay veya soru) kenar çubuğunda, kartta, grid sekmesinde, palette ve tek oturum başlığında aynı turuncu tonla gösterilir; `activity` canlı Run'ı "Çalışıyor" ve "Sessiz" diye ayırır. Sessizlik yine beklemek sayılmaz. Tonlar `src/web/sessionStatus.tsx` içinde tek yerden türetilir.

**Masaüstü menüsü.** Yenileme `Ctrl+Shift+R`, pencere kapatma `Ctrl+Shift+W` oldu. `Ctrl+R` ve `Ctrl+W` kabukta geçmiş araması ve kelime silmedir; menü hızlandırıcısı olarak terminalden çalınmamalıdır.

Açık kalan: gerçek Claude/Codex/Gemini CLI'larında `Alt+rakam` ve `Ctrl+PgUp/PgDn` kullanan bir akış bulunursa kısayol ailesi yeniden değerlendirilir.
