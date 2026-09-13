# Dayanıklılık dilimi uygulandı

Durum: accepted — 2026-09-13. Kapsam: [spec §8/6](../specs/agentdeck-v0.md) ve [spec §7](../specs/agentdeck-v0.md) kalıcılık/kapanış hükümleri. [ADR 0001](0001-worktree-session-branch-lifetimes.md) rollback korumasını, [ADR 0008](0008-terminal-slice-implementation.md) checkpoint bağımsızlığını doğrular.

**Kayıp cevap.** Create/launch/restart `requestId` defteri aynı daemon ömründe aynı payload'ı bir kez çalıştırır. İstemci aynı daemon ve payload için kimliği hatırlar; **10 dk** içinde cevap kaybolursa aynı kimlik tekrar kullanılır, ikinci Run açılmaz. Süre dolunca veya daemon kimliği değişince kimlik yenilenir: yeni defter boştur, eski id sessizce ikinci kayıt açardı. Otomatik yeniden deneme yoktur. Farklı oturumların ve farklı payload’ların bekleyen kimliği birbirini ezmez. İstemci en çok 1024 bekleyen kimlik tutar; süre dolan ve eski daemon’a ait kayıtlar temizlenir. Sınırda geçerli kimlik atılmaz, yeni işlem açıklamayla reddedilir; tamamlanan istek yer açar.

**Rollback.** PTY doğup state yazılamazsa yalnız kendi grubu durdurulur. Worktree beklenen OID'de ve temizse kaldırılır; kirliyse **veya** `git worktree remove` başarısızsa (kilit dahil) kaynak korunur ve yanıt `worktree: korundu` der. Kayıt yazılmaz. Launch yolunda kayıt yazılamazsa önceki `lastLaunch` ve exited görünümü kalır.

**Disk dolu.** `ENOSPC` ve izin hatası aynı yoldur: yayımlanan state değişmez, `serviceError` görünür, canlı PTY öldürülmez, yeni kalıcı mutation 503 `persistence` döner. Durdurma süreci bitirir; çıkış diske inmezse lifecycle `live` kalır, kalan süreç grubu yoktur. Bellekte sahte exited yazılmaz.

**Çöküş ve kapanış.** İki Run checkpoint'i birbirinden bağımsızdır; yarım `.tmp` Run sayılmaz. SIGKILL sonrası live kayıt orphaned olur, her iki görüntü salt okunur açılır. SIGTERM yeni mutation'ı keser, süreç gruplarını durdurur, çıkış kaydını ve son checkpoint'i bekler, kilidi bırakır. İkinci `close` zararsızdır. Yalnız WebSocket kopuşu lifecycle değiştirmez.

**Replay.** Eksik geçmiş `history-missing`, okunamayan `history-unreadable`; ikisi de boş ekran diye sunulmaz ve girdiyi kapatır.

Bilinen sınırlar: SIGKILL'e dirençli gerçek süreç grubu, gerçek disk-full aygıtı, IME/ekran okuyucu/%200 zoom ve 4–8 gerçek ajan kabulü G3/G4'te kalır. Yönetilen kimlik G2'ye bağlıdır.

Doğrulama: `npm test`, `npm run typecheck`.
