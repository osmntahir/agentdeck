# Klasör projesinde alt depolar ayrı ayrı incelenir ve izole edilir

Durum: accepted — 2026-09-13.

Git deposu olmayan bir klasör Project olarak eklenebilir. Böyle bir klasörün kendisinde diff veya worktree yoktur, ama çoğu zaman altında birden fazla Git deposu bulunur (ör. `~/work/web`, `~/work/org/api`). Bu depolar **Alt depo** olarak ele alınır.

**Keşif.** `findNestedRepos` salt okunurdur. En çok 4 seviye ve 30 depo tarar; `node_modules`, gizli klasörler ve symlink atlanır, bulunan deponun içine inilmez. Giriş ve süre bütçesi vardır. Bütçe aşılırsa veya bir dizin okunamazsa sonuç `truncated` olur; eksik liste "başka depo yok" diye sunulmaz. Keşif Project eklenirken değil, her kullanımda yapılır; klasöre sonradan eklenen depolar da görünür.

**Diff.** Yanıt `{ repos: [{ path, branch, diff, status }], truncated }` biçimindedir. Git projesinde tek değer `"."` yoludur. Klasör projesinde oturumun çalışma dizini taranır ve her depo ayrı bölüm olur. Hiç depo yoksa `409 git_required` döner; temiz diff gibi gösterilmez.

**İzole oturum.** Çalışma dizini yönetilen alanda bir kapsayıcı klasördür. Her Alt depo aynı göreli yolda kendi worktree'si olarak açılır; tüm depolarda Session branch adı aynıdır. Depo dışındaki dosyalar kopyalanmaz, symlink'lenmez: izolasyon yalnız Git'in taşıyabildiği içeriği kapsar. Kayıtta `baseCommit` null kalır ve her deponun başlangıç commit'i `worktrees: [{ path, baseCommit }]` içinde tutulur. Git projesinde `worktrees` boştur ve eski alanlar anlamını korur. Alanı olmayan eski kayıtlar `[]` okunur. Mutlak veya `..` içeren yol bozuk kayıt sayılır, çünkü yol silmede proje köküne ve cwd'ye eklenir.

**Açılış hep ya da hiç.** Tarama eksikse (`scan_incomplete`), depo yoksa (`git_required`) veya herhangi bir depoda commit yoksa (`head_missing`), hiçbir worktree açılmadan reddedilir. Açılış sırasında bir depo başarısız olursa, o ana kadar açılanlar [ADR 0001](0001-worktree-session-branch-lifetimes.md) kuralıyla geri alınır: yalnız beklenen OID'de duran ve değişmemiş kaynaklar kaldırılır. Her `git worktree` işlemi kendi deposunun common Git dizini kuyruğunda çalışır.

**Silme.** Onayın Git durumu tüm worktree'lerin durumunun yol önekli birleşimidir; biri okunamazsa onay üretilmez. Worktree'ler sırayla kaldırılır. Biri başarısız olursa `rmSync` fallback'i yoktur: kaldırılanlar kayıttan düşer, kalanlar, dosyaları ve Session kaydı korunur, hata hangilerinin kaldırıldığını söyler. Tümü kalktıktan sonra kapsayıcıdan yalnız boş klasörler `rmdir` ile kaldırılır. Ajanın depo dışına yazdığı dosya varsa kapsayıcı yerinde kalır ve yetim keşfinde görünür. Branch'ler her depoda korunur.

Reddedilen seçenekler: klasörün tamamını kopyalamak (maliyet sınırsız, ignored/bağımlılık dosyaları), klasörde `git init` yapmak (kullanıcının dosya düzenine müdahale), depo dışı dosyaları symlink'lemek (izolasyonu sessizce deler).
