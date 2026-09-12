# AgentDeck V0 karar incelemesi

> Bu rapor tarihli kanıttır; içeriği sonradan düzeltilmez ve inceleme sırasındaki ADR dosya adları korunmuştur. Numaralar daha sonra tekilleştirildi: `0002-scrollback-session-record.md` → [`0004-terminal-state-and-scrollback.md`](../adr/0004-terminal-state-and-scrollback.md), `0003-degraded-is-derived-overlay.md` → [`0005-degraded-is-derived-overlay.md`](../adr/0005-degraded-is-derived-overlay.md); 0001/0002/0003 numaraları değişmedi ve [`0006-base-commit-and-archive.md`](../adr/0006-base-commit-and-archive.md) yeni eklendi. Güncel normatif karar [spec revizyon 2](../specs/agentdeck-v0.md), bulguların tek tek sonucu [karar uzlaştırması](2026-09-12-decision-reconciliation.md).


Tarih: 12 Eylül 2026. Kapsam: yerel 14 Markdown belge, GitHub Wayfinder haritası ve 19 alt kararın açıklama/yorumları; Spotify'ın resmi Xirp tanıtımı. Bu bir ürün ve tasarım incelemesidir; runtime kod denetimi veya geçmiş araştırma deneylerinin yeniden çalıştırılması değildir. Bulgular mevcut kararları kendiliğinden değiştirmez.

## Genel değerlendirme

İlk aşama için yön mantıklı. Yerel daemon, PTY, worktree, hafif tarama görünümü ve ayrı odak terminali uygun bir temel. Linux önceliği, mevcut Electron kabuğunu korumak, IDE ve merkezi orkestrasyonu ertelemek kapsamı yönetilebilir tutuyor.

Ancak mevcut spec'i koşulsuz “uygulamaya hazır” kabul etmem. En önemli eksikler daha fazla özellik değil: güvenli orphan temizliği, doğru terminal geri dönüşü, aynı çalışma üzerinde yeniden devam edebilme ve iş sonucunun görülebilmesi. Altyapı ayrıntıları oldukça kesinleşmişken bu günlük kullanım sözleşmeleri geride kalmış.

Önerilen ilk ürün vaadi: **Bir geliştirici birkaç projede 4–8 ajan işini açabilsin, aralarında bağlamını kaybetmeden dolaşabilsin, değişiklikleri inceleyebilsin ve işini güvenle saklayabilsin.** Bu sayı önerilen doğrulama senaryosudur; makine kapasitesi iddiası değildir.

## Xirp hedefiyle uyum

Spotify'ın 10 Ağustos 2026 tarihli tanıtımı Xirp'i farklı ajan araçlarında paralel oturumlar, oturum başına worktree ve araçlar arasında çalışma bağlamını koruma üzerinden anlatıyor. Portal bağlantısı organizasyon bilgisi ve oturumlardan edinilen bilginin paylaşılmasını ekliyor. [Spotify tanıtımı](https://portal.spotify.com/blog/introducing-xirp)

AgentDeck'in worktree ve çoklu CLI temeli bu yönle uyumlu. Ancak mevcut V0; ortak bağlam, aynı görevde ajan değiştirme ve takım belleği sunmuyor. Bu bilinçli kapsam daraltması kabul edilebilir. İlk sürümü “Xirp'ten esinlenen yerel paralel ajan çalışma tezgâhı” olarak tanımlamak doğru; aynı deneyimi sunduğunu söylemek erken. Xirp'in güncel resmi sayfası da bağlamın korunmasını ve Portal ile kurumsal bilgiyi özellikle vurguluyor. Bu kaynaklar ürünün kendi beyanlarıdır; iç mimarisini doğruladığım anlamına gelmez. [Xirp](https://xirp.spotify.com/)

Portal, MCP bus, merkezi görev dağıtımı ve modelden bağımsız konuşma aktarımı V0'a alınmamalı. Buna karşılık sonuç inceleme ve aynı worktree'de devam etme ilk ürün döngüsünün parçası olmalı.

## Uygulama öncesi yeniden açılması gereken kararlar

### 1. Yüksek — Geçerli state, orphan worktree silme izni değildir

Kaynak: [Worktree temizliği](https://github.com/osmntahir/agentdeck/issues/5), [worktree ADR](../adr/0001-worktree-session-branch-lifetimes.md), [recovery kararı](https://github.com/osmntahir/agentdeck/issues/19).

Kayıtsız yönetilen yolların, state temiz yüklenirse açılışta süpürülmesi tehlikeli. Örneğin eski ama şema bakımından geçerli bir yedek geri yüklenebilir. Sonraki worktree'ler kayıtta görünmez; buna rağmen commit edilmemiş gerçek kullanıcı işi içerir. Oluşturma sırasında state yazımından önceki çöküş de kayıtsız kaynak bırakabilir. JSON doğrulaması bu kaynakların değersiz olduğunu kanıtlamaz.

**Öneri:** açılış yalnız keşfetsin ve bildirsin; otomatik silmesin. Kullanıcı yolu inceleyip açık temizleme seçebilsin. Oluşturma rollback'i yalnız o denemeye ait olduğu doğrulanan kaynaklarla sınırlı kalsın. Geçerli eski state + yeni kirli worktree senaryosu kabul testine eklensin.

Bu öneri mevcut ADR'nin açılış süpürmesi kararını açıkça değiştirir. Veri koruma için V0 öncesi ele alınmalı.

### 2. Yüksek — Son 256 KiB çıktı, terminal ekranının yerine geçmez

Kaynak: [Scrollback kararı](https://github.com/osmntahir/agentdeck/issues/3), [grid kararı](https://github.com/osmntahir/agentdeck/issues/7), [diff kararı](https://github.com/osmntahir/agentdeck/issues/13).

Tarama veya diff'e geçince xterm kaldırılıyor; dönüşte boş terminale son halka oynatılıyor. Halka başlangıcından önceki ekran içeriği, imleç konumu, terminal modları veya alternate-screen geçişleri kaybolabilir. UTF-8 sınırını korumak ANSI durumunu korumaz. Özellikle uzun yaşayan, yalnız küçük ekran bölgelerini güncelleyen ve sonra sessizleşen TUI'de dönüş ekranı yanlış olabilir. Bu, tasarımdan çıkan bir risk; bu tur runtime üzerinde yeniden üretilmiş bug değildir.

xterm normal/alternate tampon ve imleç durumu taşır; framebuffer serialization da ayrı bir yetenektir. Bu ayrım ham çıktı kuyruğu ile ekran durumunun aynı şey olmadığını destekler. [xterm tampon modeli](https://xtermjs.org/docs/api/terminal/interfaces/ibuffer/), [serialize eklentisi](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize)

**Öneri:** “tek görünür terminal” hedefini koru; “her geçişte bütün terminal durumunu at” şartını yeniden değerlendir. Küçük bounded terminal cache veya sunucuda terminal durumu + snapshot/replay adaylarını prototiple karşılaştır. Cache yalnız yakın geçişlere yardımcı olur; tam reconnect sorununu tek başına çözmez. Serialize eklentisini de ölçmeden kusursuz çözüm sayma.

Kabul: halka taşsın; alternate-screen TUI sessizken A→B→A ve Terminal→Diff→Terminal yapılsın; resize ve yeni istemci bağlantısı denensin. Görüntü ve girdi doğru olmalı. Kusursuz tarihçeyi ertelemek kabul edilebilir; kullanılabilir güncel ekranı ertelemek değil.

### 3. Yüksek — Otomatik resume, serbest komut sözleşmesini hâlâ zorluyor

Kaynak: [Komut/resume kararı](https://github.com/osmntahir/agentdeck/issues/18), [PTY araştırması](../research/pty-interactive-session-id.md), [CLI araştırması](../research/agent-cli-resume.md).

Konservatif lexer ve kör exec düzeltmesi doğru. Fakat shell açısından statik olmak, CLI açısından güvenle değiştirilebilir olmak demek değil. Örneğin araştırma Gemini'nin `--session-file` ile `--session-id` bayraklarını dışladığını söylüyor; yeni kararın çakışma listesinde `--session-file` yok. Böyle bir komuta otomatik kimlik eklemek kullanıcının geçerli komutunu bozabilir. Alt komutlar, `--` sonrası promptlar ve kısa bayrak biçimleri de açık uygunluk kuralları ister.

**Öneri:** Command kaydını koru; resume desteğini küçük, açık bir yetenek sınırında topla. Güvenle tanınmayan kullanım aynen çalışsın. Kullanıcının açık resume komutunu genel komut olarak çalıştırabileceği yol bulunsun. Karmaşık AgentAdapter çatısı gerekmiyor; fakat ajan özel kuralların ayrı modülde olması, agent-neutral ürünle çelişmez.

Gemini otomatik resume, araştırmada başarılı model konuşmasıyla uçtan uca doğrulanmamış. Desteklenen sürüm ve auth'lı PTY kabul testi olmadan kesin garantiye dönüşmemeli. Mevcut araştırma bu sınırlılığı dürüstçe yazıyor; spec de aynı kesinlik düzeyini korumalı.

### 4. Yüksek — Restart başarısızlığından aynı iş üzerinde çıkış yolu eksik

Kaynak: [Restart kararı](https://github.com/osmntahir/agentdeck/issues/4), [spec kullanıcı yolculukları](../specs/agentdeck-v0.md).

Claude/Gemini restart aynı konuşmayı hedeflerken Codex/genel komut yeniden çalışıyor. Aynı düğme farklı bağlam davranışları sunuyor. Daha kritik olarak konuşma kaydı yoksa önerilen “Yeni Session aç” varsayılan olarak proje HEAD'inden yeni worktree yaratır; mevcut oturumdaki commit edilmemiş işe devam etmez.

**Öneri:** eylemden önce “konuşmayı sürdürür” veya “komutu yeniden çalıştırır” açık olsun. Resume başarısızlığında kullanıcı mevcut cwd/branch'i koruyarak bilinçli biçimde yeni konuşma başlatabilsin. Sessiz fallback yapılmasın. Bu, mevcut değişmez Command/restart kuralının hangi ek eylemle genişleyeceği konusunda küçük bir ürün kararı gerektiriyor.

İlk PTY'nin doğması CLI konuşmasının oluştuğunu kanıtlamaz. Araştırmada metadata-only oturumların bulunabilirliği de belirsiz. Bu durum normal bir hata yolu olarak kullanıcıya çıkış sunmalı.

### 5. Orta, ürün değeri açısından öncelikli — Ajan commit yapınca teslim görünmez oluyor

Kaynak: [Diff kararı](https://github.com/osmntahir/agentdeck/issues/13), [branch başlangıcı](https://github.com/osmntahir/agentdeck/issues/15).

Mevcut diff yalnız HEAD'e göre commit edilmemiş değişiklikleri gösteriyor. Ajan işi commit ederse ekran temiz olur; görevde üretilen kod uygulama içinden incelenemez. Bu bilinçli kapsam sınırı, fakat paralel ajan ürünü için önemli bir boşluk.

**Öneri:** otomatik merge/PR eklemeden, worktree oluşturulurken başlangıç commit OID'sini kaydet ve “bu çalışmanın değişiklikleri” görünümünü değerlendir. Başlangıçtan mevcut çalışma durumuna toplam değişiklik ile commit edilmemiş değişikliği açık ayır. Eski kayıtlarda başlangıç bilinmiyorsa uydurma. En küçük alternatif, branch/yol kopyalama ve harici inceleme akışını görünür yapmaktır.

### 6. Orta — “Beni bekliyor” hedefi ile idle göstergesi aynı ihtiyacı karşılamıyor

Kaynak: [Haritanın Destination bölümü](https://github.com/osmntahir/agentdeck/issues/1), [durum kararı](https://github.com/osmntahir/agentdeck/issues/2), [grid kararı](https://github.com/osmntahir/agentdeck/issues/7).

Haritanın ilk hedefi hangi oturumun kullanıcı beklediğini bulmak; son sözleşme yalnız sessizliği gösteriyor. `idle` için anlamsal iddia kurmamak doğru, fakat sessiz uzun işlem ile onay bekleyen ajan ayırt edilmiyor. Çok sayıda boş kabuk da dikkat göstergesini doldurabilir.

**Öneri:** V0 hedef metnini “sessiz/hatalı oturumları tarama” olarak düzelt. Gerçek bekleme algısı sonraki aşamada resmi CLI olaylarıyla araştırılsın. V0'a stdout regex sınıflandırması ekleme. Pilot kullanımda doğru oturumu bulma ve kaçırılan müdahale ihtiyacını gözlemle.

### 7. Orta — Okunamayan scrollback'i boş göstermek hata bilgisini siliyor

Kaynak: [Scrollback](https://github.com/osmntahir/agentdeck/issues/3), [degraded](https://github.com/osmntahir/agentdeck/issues/9).

Gerçekten boş tarihçe ile EACCES/EIO nedeniyle okunamayan dosya aynı yüzey oluyor. Yeni lifecycle gerekmemesi doğru; hatayı gizlemek gerekmiyor.

**Öneri:** lifecycle değişmeden terminalde küçük “Önceki çıktı okunamadı” bilgisi ve log bağlamı göster. Legacy/missing dosya ile okuma hatasını ayır. Ayrıca yerel scrollback ADR'sindeki debounce ifadesi, sonradan kararlaştırılan azami beklemeli periyodik flush ile güncellensin.

### 8. Orta — Silme onayının kapsamı ve maliyeti tam kapanmamış

Kaynak: [spec DELETE/delete-preview sözleşmesi](../specs/agentdeck-v0.md), [worktree temizliği](https://github.com/osmntahir/agentdeck/issues/5).

İçerik fingerprint'i eski onayla silmeyi önlemek için güçlü bir karar. Fakat büyük untracked dosyalarda hash işleminin zaman/bayt sınırı yok. Ayrıca kirli tanımı ignored dosyaları dışlıyor; worktree kaldırılınca yerel ignored dosyalar da kaybolabilir. Onay metninin bu kapsamı söylemesi gerekir.

Opsiyonel branch silmede onayın branch adı, mevcut tip OID'si ve unique-commit değerlendirmesini bağlayıp bağlamadığı açık değil. Yalnız dirty fingerprint temiz branch'e sonradan eklenen commit'i yakalamaz.

**Öneri:** maliyet sınırı aşılırsa onay üretme; kullanıcıya yerel temizlik yolu göster. Ignored içerik kaybını onayda açıkla. Branch silme onayını branch kimliği ve tip OID'sine bağla; uygulama öncesi tekrar doğrula. Dış Git işlemlerine karşı atomiklik sınırını ayrıca yaz.

### 9. Orta — Worktree hazırlığı günlük kullanım varsayımlarını eksik bırakıyor

Kaynak: [İlk kullanım](https://github.com/osmntahir/agentdeck/issues/14), [başlangıç OID'si](https://github.com/osmntahir/agentdeck/issues/15).

HEAD'den temiz kopya doğru. Ancak bağımlılıklar, ignored `.env`, build çıktıları ve servis portları otomatik hazır olmayacak. Kullanıcı yeni oturumdan çalışan geliştirme ortamı beklerse ilk deneyim sürtünmeli olabilir. Worktree dosya çalışma kopyasını ayırır; tüm makine kaynaklarını izole etmez. [Git worktree belgesi](https://git-scm.com/docs/git-worktree)

**Öneri:** V0'da otomatik secret kopyalama veya setup framework kurma. İlk akışta bu sınırı söyle, cwd'ye erişim sun ve gerçek projede kurulum/test akışını kabul senaryosuna ekle. Tekrarlanan ihtiyaç ölçülürse daha sonra proje setup komutu tasarla.

## Korunması gereken kararlar

- **Daemon sahipliği:** pencere ömründen bağımsız PTY temel ürün değerine hizmet ediyor. tmux ve systemd'yi ertelemek makul.
- **Session / Run / Conversation id ayrımı:** yeniden bağlantı, yeniden çalıştırma ve ajan bağlamını birbirine karıştırmıyor. Run'ı sırf gelecek ihtimali için ayrı kalıcı geçmiş sistemine büyütmeye gerek yok.
- **Lifecycle / activity / health ayrımı:** ağ kopuşu veya eksik cwd süreç gerçeğini bozmuyor.
- **Worktree ile branch'in ayrı ömürleri:** branch kullanıcıya ait; stop dosyaları silmiyor. Otomatik orphan süpürmesi bunun istisnası olmamalı.
- **Tek writer ve süreç grubu doğrulaması:** kill timeout'unu başarı saymamak, eski callback'i Run kimliğiyle elemek temel doğruluk gereği.
- **Copy-on-write state, schema doğrulama, bozulmada durma:** yerel tek daemon için JSON yeterli olabilir. Sırf kurumsal görünmek için veritabanı eklemem.
- **Tek state poll ve bounded preview:** başlangıç ölçeğinde makul. Ayrı event bus gerektirmiyor.
- **Grid'in sabit sırası, klavye odağı, gerçek metin durumları:** kullanılabilirlik açısından iyi düşünülmüş.
- **Bounded diff ve yavaş WS tüketicisini ayırma:** kullanıcı arayüzünün maliyetini sınırlar. 32 PTY limitinin ölçülmüş kapasite diye sunulmaması doğru.

## Belge bazında sonuçlar

- **README.md:** mevcut runtime tanıtımı ile gelecek spec ayrılmalı. Electron hem mevcut hem kapsam dışı listeleniyor. “Sekmelerde tüm terminaller mount'ta kalır” anlatımı yeni hedefle farklı; mevcut davranış diye etiketlenmeli. Node/Git gereksinimleri uygulama tesliminde gerçekten kullanılan özelliklerle doğrulanmalı.
- **CONTEXT.md:** en güçlü belgelerden biri. Kimlik ve lifecycle ayrımları korunmalı. Conversation id tanımındaki Claude/Gemini uygunluğu genel terim yerine V0 destek politikası olarak ayrı anlatılabilir.
- **CLAUDE.md:** kısa ve işe yarar giriş. Tracker/domain işaretçileri yeterli; ürün spec'ine işaretçi eklemek keşfi kolaylaştırır.
- **docs/agents/domain.md:** sözlük ve ADR çelişkisini açık söyleme disiplini iyi.
- **docs/agents/issue-tracker.md:** GitHub yorumları karar kaynağı olarak belirgin. Fakat yerel ADR linklerinin issue yorumunda göreli kullanımı doğru repo dosyasına götürmeyebilir; tam blob bağlantıları tercih edilmeli.
- **docs/agents/triage-labels.md:** işleyiş için yeterli; ürün mimarisine ilişkin itiraz yok.
- **0001-worktree-session-branch-lifetimes.md:** branch ömrü doğru; otomatik sweep değişmeli. “Destroy atomiktir” ifadesi güncel kısmi başarı sözleşmesiyle çelişiyor; başarısızlığa dayanıklı sıralı işlem olarak düzeltilmeli.
- **0002-command-not-agentkind.md:** Command kimliği doğru; CLI resume mantığının ayrı test edilebilir modülde olması engellenmemeli.
- **0002-scrollback-session-record.md:** ayrı dosya ve kayıt ömrü iyi; trailing debounce metni eskimiş, ekran restorasyonu ayrıca çözülmeli.
- **0003-degraded-is-derived-overlay.md:** model korunmalı; scrollback okuma hatası lifecycle eklemeden görünür yapılmalı.
- **0003-restart-derived-spawn.md:** aynı kayıt/worktree ilkesi iyi; eski bayrak düşürme paragrafı ve sonraki revizyonu birlikte okumak hata riski yaratıyor. Güncel normatif karar tek yerde açık olmalı; eski karar tarihçe olarak ayrılmalı.
- **docs/research/agent-cli-resume.md:** sürüm ve ölçüm sınırlarının yazılması güçlü. Gemini hakkında bazı kesin “hiçbir şekilde” ifadeleri test edilen yol/sürümle sınırlanmalı; belgede doğrulanmamış alternatif zaten var. Eski JSON kayıt gözlemi güncel JSONL yazımıyla karıştırılmamalı.
- **docs/research/pty-interactive-session-id.md:** PTY ile headless ayrımı ve stdout scraping'den kaçınma değerli. Hook/kimlik üretimi, başarılı konuşma devamı garantisi değildir. Araştırma denemelerindeki izin bayrakları ürün varsayılanlarına taşınmamalı.
- **docs/specs/agentdeck-v0.md:** güçlü uygulama devir metni; yarışlar, hata yolları ve kabul kapısı iyi. Yukarıdaki yüksek öncelikli konular kapanmadan “kararlar tamamlandı” ifadesini koşullu yapmak gerekir. API yetki/origin temelini koru; ürün güvenlik incelemesinin yapıldığı bu rapordan çıkarılmamalı.

ADR numaraları ayrıca tekilleştirilmeli: iki adet 0002 ve iki adet 0003 var. Dosya adıyla bağlantılar çalışabilir, fakat yalnız numarayla atıf belirsiz. GitHub yorumları, ADR ve devir spec'i arasında güncel karar önceliği açık olmalı. Bugün bazı çelişkiler ancak sonraki resolution yorumları okunarak çözülüyor.

## İlk aşamayı nasıl sıralardım?

1. **Güvenilir tek iş:** daemon sahipliği, state doğrulama, Run, doğru stop, worktree koruma; otomatik orphan silme yok.
2. **Gerçek terminal geri dönüşü:** gerçek ajan TUI ile ekran restorasyonu, replay yarışı ve istemci yeniden bağlantısı. Bu risk UI tamamlandıktan sonraya bırakılmamalı.
3. **Başlat → çalış → incele → devam et:** aynı worktree'de resume hata çıkışı, açık restart semantiği ve görev değişikliklerine erişim.
4. **Çoklu iş tarama:** birkaç gerçek oturumla grid, sessizlik göstergesi, klavye ve odak. Sonra sentetik 32 PTY/256 kayıt sınır testleri.
5. **Kabul ve anlatım hizası:** disk hata/çöküş testleri, silme onayı, büyük çıktı; README/ADR/spec'in tek davranışı anlatması.

Portal, ajan bus, IDE, otomatik merge/PR ve merkezi takım belleği sonraya kalır. Mevcut çoklu istemci desteği tutulursa input/resize tek sahipliği de tutulmalı; bunun maliyeti azaltılacaksa çoklu istemci kapsamı açıkça daraltılmalı, yarış güvenliği çıkarılmamalı.

## Wayfinder için önerilen yeni frontier

Bunlar bu incelemede açılmış veya çözülmüş GitHub ticket'ları değildir; önerilen net sorulardır:

1. Kayıtsız worktree'ler kullanıcı işi kaybedilmeden nasıl keşfedilir ve temizlenir?
2. Halka taştıktan sonra sessiz bir TUI'ye doğru ekranla nasıl dönülür?
3. Otomatik resume hangi komutları dönüştürür ve başarısızlığında aynı iş nasıl sürdürülür?
4. Commit edilmiş ve edilmemiş görev sonucu hangi referansa göre incelenir?
5. Silme onayı branch değişimini ve büyük/ignored dosya kapsamını nasıl ele alır?

İlk üçü uygulama tasarımını bloke eder. Son ikisi ilk kullanılabilir sürümün kullanıcı sözleşmesini tamamlar. Terminal restorasyonu gerçek PTY prototipiyle, kalanlar kısa karar revizyonlarıyla kapatılabilir. Bütün haritayı baştan planlamaya gerek yok.

## İnceleme sınırları

GitHub'da harita ve 19 alt ticket kapalı görünüyor; kapanmış olmaları ürünün uygulanmış veya test edilmiş olduğunu göstermiyor. Kaynak belgelerdeki önceki deneyleri bu tur yeniden koşmadım; bunları tarihli araştırma kanıtı olarak değerlendirdim. Öneriler için yeni benchmark veya kullanıcı testi sonucu iddia etmiyorum. Mevcut karar belgeleri ve ürün kodu değiştirilmedi; yalnız bu rapor eklendi.
