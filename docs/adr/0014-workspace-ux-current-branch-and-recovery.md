# Proje klasörü varsayılandır; branch Git'ten okunur, yarım kalan iş açılışta geri gelir

Durum: accepted — 13 Eylül 2026, kullanıcı geri bildirimiyle.

**Varsayılan izolasyon.** Yeni oturum varsayılan olarak proje klasöründe (shared) açılır ve branch oluşturmaz. Ajanlar branch'i kendileri açar veya checkout eder. Worktree ve Session branch yalnız "İzole çalışma" seçilince oluşur; [ADR 0001](0001-worktree-session-branch-lifetimes.md) yaşam süresi kuralları o durumda aynen geçerlidir.

**Güncel branch.** Arayüzdeki branch `Session.branch` açılış kaydından değil, `GET /api/sessions/:id/git` ile anlık Git okumasından gelir (2 sn önbellek, en çok 1000 yerel branch). `POST /api/sessions/:id/git/switch` yalnız temiz çalışma ağacında ve beklenen HEAD/branch/Run hâlâ geçerliyse `git switch --no-guess [-c]` çalıştırır. Force, reset, stash veya uzak branch tahmini yoktur; kirli ağaç reddedilir. Branch değişimi yeni Run açmaz, `Session.branch` kaydını değiştirmez.

**Gezinme.** Sol proje listesi yalnız canlı veya kalan süreç grubu olan arşivsiz oturumları gösterir. Bitmiş ve yetim kayıtlar silinmez; Oturumlar taramasında durur.

**Açılışta geri açma.** Ayar açıkken (varsayılan açık) yalnız `orphaned`, arşivsiz ve dizini erişilebilir oturumlar aynı Session ve cwd üzerinde yeni Run ile açılır. Açık konuşma kimliği varsa o komut, Claude/Codex/Gemini'de CLI seçicisi, kimliği doğrulanmamış ek presetlerde (Grok, OpenCode, Antigravity) literal yeni başlangıç kullanılır. Bilerek durdurulan (`exited`) işler ve serbest komutlar otomatik çalışmaz. Aynı Run için istek kimliği sabittir; sayfa yenilemesi ikinci Run üretmez. Konuşma kimliği tahmini [ADR 0003](0003-restart-derived-spawn.md) gereği yapılmaz.

**Sunum.** Ajan simgesi başlangıç komutundan veya Linux'ta PTY süreç ağacındaki program adından türetilir; kabuk `-c` metni aranmaz ve bu bilgi konuşma kimliği değildir. Bildirim yalnız süreç çıkışında gelir; sessizlik tamamlanma sayılmaz. Proje rengi, bildirim, önizleme ve kompakt görünüm tercihleri tarayıcı profilinde (`localStorage`) tutulur, daemon state'ine girmez.
