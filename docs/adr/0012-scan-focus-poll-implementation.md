# Tarama, odak, poll ve environment.json dilimi uygulandı

Durum: accepted — 2026-09-13. Kapsam: [spec §8/5](../specs/agentdeck-v0.md) ürün entegrasyonu ve [spec §3](../specs/agentdeck-v0.md) `environment.json`. [ADR 0005](0005-degraded-is-derived-overlay.md) overlay'si durum görünümüne bağlanır; [ADR 0010](0010-terminal-grid.md) tarama/odak boşluğunun kart ve krom tarafını kapatır.

**environment.json.** `~/.config/agentdeck/environment.json` her Run öncesi okunur. Dosya yoksa boştur. Kullanıcı sahibi, grup/diğer erişimi kapalı, 64 KiB tavan, düz string nesnesi. Parse/izin hatasında Run başlamaz (`409 environment_invalid`); create worktree açmaz, restart canlı işi durdurmaz. `TERM` ve `AGENTDECK_*` rezervdir. Parent ajan işaretçileri (`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION`, `CLAUDE_CODE_SESSION_ID`, `GEMINI_CLI_SESSION_ID`) reddedilir; `CLAUDE_CODE_*` öneki topluca yasaklanmaz. Hata mesajı değer taşımaz. Testler `DaemonOptions.environmentFile` ile dosya yolunu verir.

**Degraded.** `/api/state` oturum ve proje görünümüne türetilmiş `degraded` ekler. Proje kökü ve benzersiz cwd 2 sn önbellekle sorgulanır; lifecycle değişmez. Kart, kenar çubuğu ve üst bant bu metni overlay olarak gösterir.

**Poll.** Görünür istemci `createStatePoller` ile tek GET döngüsü kullanır: hemen, sonra önceki istek bitişinden 2 sn; 5 sn timeout; mutation ve önizleme kimliği değişince beklemeden tazeleme. `daemonId`/revision/generation eski cevabı atar; eşit revision işlenir. Gizli sekmede durur. 401/403 otomatik denemeyi keser; ağ/sunucu hatası 2/4/8/10 sn geri çekilir. Yaş `serverNow` + `performance.now()` ile ilerler. Tarama kartları gizliyken `previewIds` boştur; önceki 24 kartlık GET iptal edilir, böylece 5 sn timeout girdi kapatmaz.

**Kart ve bant.** Kartta ad, proje, program, lifecycle/activity, cwd/proje hata metni, çıkış, branch/izolasyon, önizleme ve yaş vardır. Idle hata rozeti değildir. Silme ikincil düğmedir. İzole canlı oturumda kapatılabilir güven notu vardır; uygulama onay vermez.

**Odak.** F6 terminalden kromuna çıkar; Electron menüsü gerçek F6'yı PTY'ye gönderir (`CSI 17~`). Escape PTY'de kalır; kromda önce modal, sonra tarama. Kart ve kenar listesi roving Tab / okla aday, Enter/Space ile açılır; aday değiştirmek PTY açmaz. Kullanıcı seçiminden sonra replay hazırken odaklanır; reconnect çalmaz. Tarama Workspace gizli kalarak kaydırma ve filtreyi korur. Silme komşu karta döner, komşu PTY açılmaz.

Açık kalanlar: grid panellerinin kendi içindeki tam klavye döşemesi, dar ekran çekmece odağı (çekmece yok), IME / ekran okuyucu / %200 zoom ve 4–8 gerçek CLI kabulü (G3/G4).

Doğrulama: `npm test`, `npm run typecheck`. DOM davranışı derlenmiş arayüzde tarayıcı duman testiyle bakılır.
