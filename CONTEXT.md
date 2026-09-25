# AgentDeck

Yerel, proje odaklı ajan ve terminal çalışma tezgâhı. Kullanıcı paralel işleri açar, inceler ve aynı çalışma üzerinde devam eder.

## Language

**Project**:
Arayüze eklenmiş yerel klasör; Session kayıtlarının kapsayıcısıdır. Git projesi bir çalışma kopyası köküdür. Klasör projesi Git deposu olmayan bir klasördür; ortak oturumlar doğrudan klasörde çalışır, diff ve izolasyon altındaki Alt depolar üzerinden yapılır.

**Genel**:
Projesiz oturumların kaydı: ev klasöründe tek bir klasör projesi (`general`). İlk projesiz oturumda oluşur, kenar çubuğunda en üstte durur. Oturumları yalnız ortak klasörde çalışır; izolasyon ve alt depo taraması yoktur. Kalan her şeyde sıradan bir Project gibidir: işleri olabilir, kaldırılması proje silme onayından geçer.
_Avoid_: varsayılan proje, ev projesi

**Alt depo**:
Klasör projesinin alt klasörlerinde bulunan Git deposu. Keşif sınırlıdır: en çok 4 seviye ve 30 depo taranır; `node_modules`, gizli klasörler ve symlink atlanır; bulunan deponun içine inilmez. Sınır aşılırsa liste eksik bildirilir, "başka depo yok" sonucu çıkarılmaz.
_Avoid_: submodule, iç içe proje

**Session**:
Bir çalışma kaydı ve ona bağlı ardışık Run'lar. Süreç sonlandığında çalışma kaydı yaşayabilir.
_Avoid_: Tek süreç, CLI konuşması

**İş**:
Kullanıcının adlandırdığı amaç (ör. "Çoklu dil desteği"). Bir projedeki Session'ları ve onların Conversation kayıtlarını bir araya toplar. İş silinince Session'ları da proje silmedeki gibi tek bir önizleme onayıyla silinir: izole çalışma kopyaları kalkar, branch'ler ve ortak klasör dosyaları korunur. Bağlı Claude arka plan oturumları ve konuşma dosyaları Claude'da kalır. İşte açılan Claude terminali düz `claude` konuşmasıdır; AgentDeck arka plan oturumu açmaz. Claude arka plan oturumları işe elle bağlanır. Bir Session en çok bir işe bağlıdır.
_Avoid_: Claude session, görev (Session adıyla karışır)

**Claude arka plan oturumu**:
Claude Code'un kendi yönettiği, `claude agents` ile listelenen ve `claude attach <kısa-id>` ile açılan oturum. AgentDeck Session'ı değildir; bir İş'e bağlanabilir, kapatılan terminal onu durdurmaz.
_Avoid_: Session (AgentDeck anlamında), job

**Conversation kaydı**:
Bir Session'ın Run'ında ajan CLI'ının bildirdiği konuşma kimliği, başlama nedeni (yeni, sürdürme, /clear, /compact) ve transcript yolu. Claude'da SessionStart kancasıyla gelir; ekran çıktısından okunmaz. Kayıt konuşmanın hâlâ açılabildiğini kanıtlamaz. /rename adı /clear sonrası yeni konuşmaya kopyalandığı için konuşmayı ayırt etmekte ad değil istem kullanılır.
_Avoid_: Session (AgentDeck anlamında)

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
İzole bir Session'ın Git çalışma kopyası. Çalışan süreçten bağımsız olarak kullanıcı işini taşır. Klasör projesindeki izole Session her Alt depo için, kapsayıcı çalışma dizininde aynı göreli yolda bir worktree taşır; depo dışındaki dosyalar kopyalanmaz.
_Avoid_: Güvenlik sandbox'ı, session branch

**Session branch**:
Worktree oturumu oluşturulurken açılan, kullanıcıya ait Git branch'i. Klasör oturumunda her Alt depoda aynı addır. Session kaldırılması branch'i kaldırmaz.

**Korunan branch**:
Session kaldırılsa da Git'te kalan `agentdeck/` önekli Session branch'i. Proje görünümünde ad ve tip OID'siyle listelenir; branch'i gösteren kayıt yoksa görev bilgisi uydurulmaz. Uygulama branch silmez.

**Base commit**:
Çalışmanın başlangıcında seçilen commit; kayıtta `baseCommit` alanıdır. Çalışmanın toplam değişikliğini incelerken kullanılan sabit referanstır. Bilinmiyorsa uydurulmaz. Klasör oturumunda tek bir base commit yoktur; her Alt depo worktree'si kendi commit'ini `worktrees` kaydında tutar.
_Avoid_: HEAD, hareketli ana branch

**Isolation**:
Session'ın proje çalışma kopyasıyla ilişkisi: worktree kendi kopyası (klasör projesinde her Alt depo için ayrı kopya taşıyan kapsayıcı dizin); shared ortak proje köküdür ve yeni oturumun varsayılanıdır.

**Güncel branch**:
Çalışma dizininde Git'ten o an okunan branch veya ayrık HEAD. Ajan veya kullanıcı değiştirebilir; Session branch açılış kaydının yerine geçmez.
_Avoid_: Session.branch ile eşanlamlı kullanım

**Çalışma alanı**:
Oturumların sekme olarak açık tutulduğu Dockview alanı. Birden çok alan olabilir ve her birinin yerleşimi yalnız istemcide tutulur. Bir oturuma tıklamak onu etkin gruba sekme olarak ekler. Sekmeyi bir kenara sürüklemek alanı böler (ADR 0019).
_Avoid_: Terminal grid (eski ad)

**Sekme**:
Çalışma alanında açık tutulan bir Session. Oturumun içinde sekme yoktur. Sekmeyi kapatmak oturumu durdurmaz. Arka plandaki sekme "kullanıcı bakıyor" sayılmaz.
_Avoid_: alt terminal, oturum içi sekme

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

**Doğrulanmış durdurma**:
Süreç grubunun gerçekten bittiğinin kanıtlandığı durdurma. Liderin çıkması yetmez, grubun boşaldığı ayrıca sorgulanır; süre dolması başarı sayılmaz. Doğrulanmamış durdurmadan sonra yeni Run başlamaz ve silme yapılmaz.
_Avoid_: kill, timeout ile durdurma

**Kalan süreç grubu**:
Lideri çıkmış ama içinde hâlâ süreç bulunan bir Run'ın süreç grubu. Kaydı düşerse kalan çocuklar durdurulamaz; yeniden sinyal göndermeden önce pid'in yeniden kullanılmadığı doğrulanır.
_Avoid_: zombi, orphaned

**Tek yazar kilidi**:
Canonical veri dizinine bağlı, daemon'ın state'e dokunmadan önce aldığı kilit. Aynı veri dizinini farklı porttan veya symlink alias'ından açan ikinci daemon reddedilir.

**Silme onayı**:
Kullanıcının ne silineceğini gördükten sonra üretilen, süreli ve daemon ömrüne bağlı onay. Session ve Run kimliği, çalışma dizininin kimliği ve içerik durumuna bağlanır; bunlardan biri değişmişse onay eskimiştir ve silme yapılmaz.
_Avoid_: force delete, onay bayrağı
