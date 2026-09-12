# AgentDeck

Yerel, proje odaklı ajan ve terminal çalışma tezgâhı. Kullanıcı paralel işleri açar, inceler ve aynı çalışma üzerinde devam eder.

## Language

**Project**:
Arayüze eklenmiş Git çalışma kopyası kökü; Session kayıtlarının kapsayıcısıdır.

**Session**:
Bir çalışma kaydı ve ona bağlı ardışık Run'lar. Süreç sonlandığında çalışma kaydı yaşayabilir.
_Avoid_: Tek süreç, CLI konuşması

**Run**:
Bir Session'a bağlı tek PTY çalıştırması. Yeniden bağlanma aynı Run'ı izler; yeniden çalıştırma yeni Run'dır.

**Command**:
Session'ın kullanıcının seçtiği başlangıç programı; null etkileşimli kabuk anlamındadır. Sonraki bir Run için seçilmiş farklı program başlangıç niyetini değiştirmez.
_Avoid_: AgentKind, preset id

**Launch intent**:
Bir Run'ın nasıl başlatıldığının kaydı: command (programı aynen çalıştır), fresh (yeni konuşma), resume (açık kimlikli konuşma) veya picker (CLI'ın kendi seçicisi). Session kaydında `lastLaunch` olarak son başarılı Run'ın niyeti durur; başlangıç Command'ını değiştirmez.
_Avoid_: Command ile eşanlamlı "komut", restart bayrağı

**LaunchPolicy**:
Hangi tam komut çağrısının yönetilen konuşma eylemlerine uygun olduğunu söyleyen dar izin listesi. Liste dışındaki her komut geçerlidir ve aynen çalışır; uygun olmamak hata değildir.
_Avoid_: Ajan adaptörü, bayrak kara listesi

**Conversation id**:
Ajan CLI'ındaki bir konuşmanın kimliği. Session veya Run kimliği değildir; bir kimliğin bilinmesi konuşmanın erişilebilir olduğunu kanıtlamaz.
_Avoid_: Session id, resume id

**Worktree**:
İzole bir Session'ın Git çalışma kopyası. Çalışan süreçten bağımsız olarak kullanıcı işini taşır.
_Avoid_: Güvenlik sandbox'ı, session branch

**Session branch**:
Worktree oturumu oluşturulurken açılan, kullanıcıya ait Git branch'i. Session kaldırılması branch'i kaldırmaz.

**Base commit**:
Çalışmanın başlangıcında seçilen commit; kayıtta `baseCommit` alanıdır. Çalışmanın toplam değişikliğini incelerken kullanılan sabit referanstır. Bilinmiyorsa uydurulmaz.
_Avoid_: HEAD, hareketli ana branch

**Isolation**:
Session'ın proje çalışma kopyasıyla ilişkisi: worktree kendi kopyası; shared ortak proje köküdür.

**Lifecycle**:
Yönetilen PTY'nin durumu: live, exited veya orphaned. Activity ve çalışma kopyası sağlığı ayrı kavramlardır.

**Activity**:
Canlı Run'ın girdi/çıktı hareketliliği: active veya idle.

**lastActivity**:
Canlı Run'dan en son PTY çıktısı veya kabul edilmiş kullanıcı girdisi geçtiği an.

**idle**:
Bir süre girdi/çıktı üretmemiş canlı Run. Sessizliktir; kullanıcı beklediğini kanıtlamaz.

**orphaned**:
Önceki daemon'dan yönetilebilir PTY bağlantısı ve bilinen çıkış sonucu kalmamış Session.
_Avoid_: crashed, orphan worktree

**Orphan worktree**:
Yönetilen alanda bulunup hiçbir Session kaydının göstermediği çalışma kopyası veya Git worktree kaydı. Kullanıcı işi içerebilir.

**Degraded**:
Kayıt dururken çalışma dizini veya proje kökünün kullanılamaması. Lifecycle'dan ayrı, mevcut erişilebilirlik durumudur.

**Preset**:
Başlangıç Command'ını dolduran gömülü kısayol. Kalıcı ajan kimliği değildir.

**Terminal state**:
Bir Run'ın ekranda tuttuğu hücreler, imleç, terminal modları ve sınırlı görüntü geçmişi.
_Avoid_: Ham çıktı kuyruğu, ajan konuşma bağlamı

**Snapshot**:
Terminal state'in bir sıra numarasına bağlı, aynı boyutlarda yeniden kurulabilen temsili. Güvenli bir kontrol dizisi sınırında alınır; o anda tüketilmemiş kontrol prefix'i snapshot'ın parçası değil, sonraki ilk devam verisidir.
_Avoid_: Çıktı kuyruğu, ekran görüntüsü dosyası

**Checkpoint**:
Bir Run'ın terminal state'inin diskteki kalıcı kaydı. Okunamaması, geçmişin boş olmasıyla aynı şey değildir.

**Scrollback**:
Terminal state'in önceki görüntü satırları. Tam konuşma arşivi veya birebir süreç çıktısı kaydı değildir.

**Preview**:
Terminal state'teki görünür satırlardan türetilmiş, tarama kartında sunulan sınırlı metin görünümü.
_Avoid_: ANSI silinmiş çıktı, anlamsal ajan durumu

**Terminal control**:
Bir istemcinin kullanıcı girdisi ve boyut gönderebilmesi için geçici kontrol sahipliği. Kontrolü bırakmak Run'ı bitirmez.

**Archive**:
Çalışma kaydını aktif taramadan kaldırıp daha sonra bulunabilir tutma. Worktree veya branch temizliği değildir.
