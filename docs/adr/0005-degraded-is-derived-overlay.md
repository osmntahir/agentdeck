# Degraded lifecycle değeri değildir

Durum: accepted. Eski dosya adı `0003-degraded-is-derived-overlay.md`; ADR numaraları tekilleştirilirken 0005'e taşındı, karar değişmedi.

Eksik cwd/proje kökü mevcut erişilebilirlikten türetilen overlay'dir; live/exited/orphaned süreç gerçeğini değiştirmez. Daemon kopuşu istemci bağlantı durumudur. Terminal geçmişi veya snapshot okuma hatası ayrıca görünür “önceki görüntü okunamadı” bilgisi taşır; yeni lifecycle oluşturmaz, boş geçmiş diye gizlenmez.
