# İş sonucu başlangıç commit'ine göre incelenir ve arşivlenebilir

Durum: accepted — 2026-09-12.

Worktree oluştururken kullanılan commit OID, Session.baseCommit olarak kalıcıdır. Varsayılan görev diff'i bu referanstan mevcut tracked çalışma ağacına toplam değişikliği ve ayrıca untracked dosyaları gösterir; commit edilmemiş görünüm ayrı kalır. Shared değişiklikleri bir ajana atfedilmez. Başlangıç bilinmiyorsa otomatik referans uydurulmaz.

Arşivleme durmuş Session'ı grid'den kaldırır, kaydı/worktree'yi/branch bilgisini korur; filtreyle bulunur ve geri alınabilir. Silme branch'i korur. Projede “Korunan branch'ler” görünümü Git'teki agentdeck/ refs'lerini salt okunur listeler; kayıt yokken görev adı veya başarı durumu uydurmaz. Bu, PR/merge otomasyonu eklemeden kullanıcının işini bulmasını sağlar.
