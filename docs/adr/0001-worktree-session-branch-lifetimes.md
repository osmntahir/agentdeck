# Worktree açık temizlikle kaldırılır; branch kullanıcıya aittir

Durum: accepted — 2026-09-12 inceleme revizyonu. Önceki otomatik orphan süpürmesi ve atomik destroy tarifi yürürlükten kaldırıldı.

Stop, exit, archive ve restart worktree'yi kaldırmaz. Açılış yalnız orphan kaynakları keşfeder ve bildirir; geçerli state dahi kayıtsız kaynağın değersiz olduğunu kanıtlamaz. V0 orphan temizliğini otomatik veya UI üzerinden force yapmaz; yol ve Git kayıt bilgisi sunar, kullanıcı yerel Git ile inceler. Create rollback'i yalnız kendi denemesinin sahipliği doğrulanmış kaynaklarını kaldırabilir.

Kullanıcı Session silmesini açıkça onayladığında süreç grubu doğrulanır, worktree kaldırılır, sonra kayıt kaldırılır. İşlem fiziksel transaction değildir; kısmi başarı ve kalan kayıt görünürdür. Shared dosyalara dokunulmaz. V0 Session silme branch silmez; uygulamadan branch silme ertelendi. Böylece değişen branch tipine karşı zorunlu olmayan yıkıcı bir yarış V0'dan çıkarılır.

Ignored dosyalar dahil silinecek çalışma kopyasının kapsamı, maliyet sınırları ve onay fingerprint'i [spec](../specs/agentdeck-v0.md#6-saklama-ve-güvenli-temizlik) içinde. Arşivlemek varsayılan işi bitirme yoludur; silme ikincil ve yıkıcıdır.

Güncelleme (13 Eylül 2026): create rollback'inin kirli kopyayı koruması [ADR 0013](0013-durability-slice-implementation.md) ile ölçüldü. `git worktree remove` kilit yüzünden başarısızsa kaynak yine korunur; `rmSync` fallback yoktur.

Git projesinde commit yoksa izole worktree açıklamayla kapalıdır (`head_missing`). Yeni oturumun varsayılanı [ADR 0014](0014-workspace-ux-current-branch-and-recovery.md) ile proje klasörüdür (shared); worktree ve Session branch yalnız izole çalışma seçilince açılır. Klasör projesindeki commit'siz alt depo [ADR 0009](0009-folder-project-sub-repos.md) ile aynı kuralı kullanır.
