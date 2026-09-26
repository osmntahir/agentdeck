# Proje PR sayfası ve PR üzerinde oturum

Durum: accepted — 2026-09-26, `feat/pr-review` dalında. [ADR 0020](0020-review-notes-and-github-prs.md)'yi genişletir. [ADR 0001](0001-worktree-session-branch-lifetimes.md)'deki Session branch tanımına bir istisna ekler.

**Sorun.** ADR 0020'de PR'lar yalnız bir oturumun Değişiklikler ekranından inceleniyordu. Başkasının açtığı bir PR'ı incelemek için önce o projede ilgisiz bir oturum açmak gerekiyordu. PR'daki düzeltmeleri bir ajana yaptırmak için de PR branch'ini elle checkout edip oturumu orada başlatmak gerekiyordu.

**Karar 1 — PR'lar proje düzeyinde listelenir.** Git projelerinin açık PR'ları için ayrı bir sayfa vardır. Sayfaya şu yollardan ulaşılır:
- Kenar çubuğunda proje adının yanındaki PR sayısı.
- Proje menüsündeki "Pull request'ler" eylemi.
- Komut paleti.

Liste tam genişlikte açılır. Her satırda şunlar görünür: başlık, numara, head → base, yazar, son güncelleme, taslak işareti, CI özeti, inceleme kararı ve PR üzerinde açılmış ajan. Bir PR seçilince ADR 0020'deki inceleme ekranı gelir. Üstteki seçici ve oklar PR'lar arasında geçer. Esc önce listeye, sonra geldiğin yere döner. Uçlar:
- `GET /api/projects/:id/github/pulls` (`fresh=1` önbelleği atlar)
- `GET /api/projects/:id/github/pulls/:n`
- `POST /api/projects/:id/github/pulls/:n/review`

Uçlar proje kökünde çalışır. Klasör projesinde ve Genel'de 409 `git_required` döner.

**Karar 2 — Sayı ucuz tutulur.** Kenar çubuğu git projelerini 3 dakikada bir sorar; pencere gizliyken sormaz. Daemon listeyi proje başına 60 sn önbellekler, aynı anda gelen istekler tek `gh` çağrısını paylaşır. Başarısız okuma önbellekte kalmaz. Okunamayan projede (`gh` yok, oturum yok, GitHub dışı uzak depo) sayı gösterilmez. Hata kenar çubuğuna taşınmaz, PR sayfası açılınca gösterilir.

**Karar 3 — CI özeti `statusCheckRollup`'tan türetilir.** Kontrollerden biri FAILURE, ERROR, CANCELLED, TIMED_OUT, ACTION_REQUIRED veya STARTUP_FAILURE ise sonuç `failure` olur. Değilse ve biri bitmemişse `pending`, hepsi bittiyse `success`, hiç kontrol yoksa `null` olur. Ayrıntı GitHub'dadır; AgentDeck kontrol adlarını göstermez.

**Karar 4 — PR üzerinde oturum PR'ın head commit'inden açılır.** `POST /api/sessions` isteğe bağlı `pullRequest: <n>` alır. Bu alan yalnız git projesinde ve `isolation: "worktree"` ile kabul edilir. Daemon şu adımları izler:
1. `gh pr view` ile head branch'i, head commit'i ve fork durumunu okur.
2. `git fetch origin refs/pull/<n>/head` ile commit'i getirir. Aynı depodaki PR'da uzak branch'i de `origin/<head>` olarak getirir.
3. Worktree'yi bu commit'ten açar.

Session'ın `baseCommit`'i PR head'idir. Bu yüzden "Bu çalışma" ajanın PR üzerine yaptığı değişikliği gösterir, PR'ın kendisini değil.

**Karar 5 — Branch adı push'u belirler.** Aynı depodaki PR'da, PR branch'i yerelde yoksa oturum branch'i PR branch'inin kendi adını alır ve `origin/<head>`'i izler. Böylece ajanın düz `git push`'u PR'a gider. Ad yerelde varsa veya PR fork'tan açılmışsa `agentdeck/pr-<n>-<id>` açılır ve izleme kurulmaz. Session kaydı `pullRequest: {number, headRefName, tracking}` taşır. İnceleme ekranı notları varsayılan olarak bu oturuma gönderir; kullanıcı projedeki başka bir terminali de seçebilir.

ADR 0001'in istisnası: PR oturumunun branch'i `agentdeck/` önekli olmayabilir. Branch yine kullanıcıya aittir, oturum silinince kalır.

**Karar 6 — Proje incelemesinin notları PR başınadır.** Taslak `project:<id>` anahtarıyla tutulur. Panel ve gönderim yalnız açık PR'ın notlarını kapsar. Başka PR'a yazılmış not bu terminale gönderilmez.

Bilinen sınırlar:
- Korunan branch paneli yalnız `refs/heads/agentdeck/` okur. PR'ın kendi adını alan oturum branch'i orada görünmez.
- Fork PR'ında ajanın değişikliği PR'a gönderilmez. Kullanıcı ayrı bir PR açar veya uzak depoyu kendisi ayarlar.
- Liste yalnız açık PR'ları gösterir (en çok 50). Kapanmış ve birleşmiş PR'lar için GitHub kullanılır.

Doğrulama: `npm test`, `npm run typecheck`, `npm run test:browser`. `tests/api.test.ts` gerçek bir bare "origin" ile şunları sınar: PR oturumunun PR head'inden açılması, `origin/<head>`'i izlemesi ve ikinci oturumda ayrı branch'e düşmesi. `tests/browser/pulls.mjs` şu akışı sürer: kenar çubuğundaki sayı, liste, arama, CI ve karar rozetleri, inceleme, terminal seçilmeden gönderimin kapalı olması, Esc ile geri dönüş, PR kipinde yeni oturum penceresi, oturumun PR branch'inde doğması, notun o ajana gitmesi ve paletten açılış. Gerçek GitHub'a karşı kullanıcı kabulü yapılmadı.
