# Claude hesapları kenar çubuğundan, sistem genelinde değiştirilir

Durum: accepted — 2026-09-23, `deneme/tur-2` dalında. Spec §3'teki "Sistem CLI auth dosyaları korunur" kuralına tek istisna getirir.

Kullanıcının birden çok Claude aboneliği var (ör. iki Pro hesap) ve her geçişte `/login` ile tarayıcıdan yeniden girmek istemiyor. Claude Code yerleşik hesap geçişi sunmuyor. İki yol değerlendirildi: her hesaba ayrı `CLAUDE_CONFIG_DIR` verip yalnız AgentDeck Run'larını etkilemek veya canlı kimlik dosyalarını değiştirip geçişi sistem geneline yaymak. Kullanıcı sistem genelini seçti: agentdeck dışında açılan `claude` da seçili hesabı kullanır, ayarlar ve geçmiş tek `~/.claude` klasöründe kalır.

**Ne değişir.** Yalnız iki alan: `.credentials.json` içindeki `claudeAiOauth` ve `.claude.json` içindeki `oauthAccount` (`CLAUDE_CONFIG_DIR` tanımlıysa ikisi de o klasördedir). `mcpOAuth` gibi komşu alanlara ve diğer ayarlara dokunulmaz. Yazım aynı dizinde geçici dosya + rename ile yapılır ve dosya izinleri korunur. İkinci yazım başarısız olursa ilki geri alınır.

**Kayıt.** Hesaplar `~/.agentdeck/claude-accounts.json` dosyasında (0600) `accountUuid` ile tutulur. HTTP yanıtları token taşımaz. Canlı hesabın üzerine yazılmadan önce o hesap her zaman kaydedilir: Claude Code'un kendi yenilediği token kaybolmaz. Hesap bilgisi okunamayan bir canlı oturum üzerine hiç yazılmaz.

**Bir kez bağlama.** "Hesap ekle", `claude auth login` komutunu `~/.agentdeck` altındaki geçici bir `CLAUDE_CONFIG_DIR` içinde, PTY'de çalıştırır. Canlı hesap giriş sürerken değişmez. Çıktıdaki giriş adresi ve kod alanı pencerede gösterilir. Başarılı girişte oluşan kimlik kayda alınır, mevcut hesap da listeye eklenir ve geçici dizin her sonuçta silinir.

**Sınırlar.** Kullanıcının gözlemine göre çalışan Claude oturumları, değişen kimlik dosyasını yeniden okuyup yeni hesaba kendiliğinden geçiyor. Bu yüzden panel geçişten sonra uyarı göstermez. macOS'ta kimlik anahtar zincirinde durduğu için panel orada kapalıdır. Codex gibi diğer ajanlar kapsam dışıdır.
