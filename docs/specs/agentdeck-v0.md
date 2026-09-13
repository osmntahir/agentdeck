# AgentDeck V0 — revize ürün ve uygulama sözleşmesi

Revizyon: 2.2 — 12 Eylül 2026. **Durum: tasarım kararları kapandı ve terminal temsili ölçümle doğrulandı. Açık kalan tek şey insan onayı gerektiren CLI kabul testidir (G2); ürün kabulü (G3/G4) yapılmadı. Hatasız ürün iddiası yoktur.** [Wayfinder haritası](https://github.com/osmntahir/agentdeck/issues/1), [doğrulama kapıları](agentdeck-v0-validation-gates.md).

Bu belge güncel normatif sözleşmedir; ADR'ler gerekçeyi, araştırmalar tarihli kanıtı taşır. Eski GitHub resolution yorumları tarihçedir; çelişen önceki hükümler bu revizyonla yürürlükten kalkar. İki incelemedeki 15 bulgunun karşılığı [revizyon kaydında](../reviews/2026-09-12-decision-reconciliation.md); terminal kararlarının ölçüm kanıtı [doğrulama notunda](../research/terminal-state-validation.md).

**Uygulama durumu:** §8/1, §8/3 terminal dilimi, §8/4 çalışma sonucu dilimi ve §8/5 tarama/odak/poll
entegrasyonu (environment.json dahil) ürün koduna girdi. Sınırlar
[ADR 0007](../adr/0007-slice-1-implementation-boundaries.md),
[ADR 0008](../adr/0008-terminal-slice-implementation.md),
[ADR 0011](../adr/0011-work-result-slice-implementation.md) ve
[ADR 0012](../adr/0012-scan-focus-poll-implementation.md) içinde. Gerçek tarayıcı/CLI
ürün kabulü, §8/2 insan kabulü ve §8/6 kabulleri açık; sözleşmenin bütünü uygulanmış değildir.

## 1. Hedef ve kapsam

Linux öncelikli, yerel Node daemon + React/Vite + xterm.js + node-pty + ws + execFile Git. Mevcut Electron başlatıcı korunur. Amaç birkaç projedeki paralel ajan işini başlatmak, terminale doğru ekranla dönmek, sonucu incelemek ve aynı dosyalarda devam etmektir. İlk kullanıcı doğrulaması 4–8 gerçek oturumla; 32 PTY başlangıç teknik tavanı ayrıca ölçülür.

Pencere kapanınca daemon ve PTY sürer. Daemon ölümü sonrası süreç devamı garanti edilmez; otomatik respawn yapılmaz. Worktree dosya izolasyonudur; güvenlik sandbox'ı veya port/servis izolasyonu değildir. Xirp'in çoklu ajan/worktree yönünden esinlenilir; model değişiminde konuşma aktarımı ve Portal özellik paritesi vaat edilmez.

V0 dışında: IDE/editör/LSP/debugger, görev dağıtıcı, ajan bus, merkezi context/Portal, tmux, systemd kurulumu, otomatik PR/merge, uygulamadan branch silme, otomatik orphan temizliği, Git dışı projeler, özel preset kataloğu. Bu sınırlar kullanıcıya gereken yerde kısa ve somut anlatılır.

## 2. Domain ve kalıcı kayıt

- Project canonical gerçek Git çalışma kopyası köküdür. Symlink/alt dizin aynı köke çözülür; aynı kök 409 existingProjectId. Bare/Git dışı kök ve AgentDeck'in kendi worktree'sini Project olarak eklemek reddedilir. Ayrı bağlı worktree ayrı Project olabilir; Git mutasyonları common Git dir anahtarıyla serileştirilir.
- Session kalıcı çalışma kaydı; Run tek PTY çalıştırması; Conversation id CLI konuşmasıdır. Kimliklerin hiçbiri diğerinin yerine geçmez.
- Session: id, projectId, name, command, isolation, cwd, branch, baseCommit|null, lifecycle, exitCode|null, exitSignal|null, createdAt, endedAt|null, runId|null, archivedAt|null, lastLaunch|null. lastLaunch, son başarıyla yayımlanmış Run'ın açık launch niyetidir: command (aynen program), fresh (izin listesindeki CLI), resume (CLI + açık id) veya picker (CLI seçicisi). fresh/resume için son dayatılmış/hedef conversationId ayrı tutulur; picker'ın seçtiği id tahmin edilmez.
- Lifecycle live|exited|orphaned; activity yalnız live için active|idle. Kabul edilmiş kullanıcı input'u ve PTY output'u lastActivity'yi ilerletir; terminalin otomatik cevapları kullanıcı faaliyeti değildir. Idle 30 sn sessizliktir. UI canlı etiketlerinde “Çalışıyor”/“Sessiz · 30 sn” kullanır; başarı veya kullanıcı bekleme sonucu çıkarmaz.
- Gözlenen exit kalıcıdır. Orphaned kayıt için bilinmeyen ölüm saati/kodu null; recovery saati ölüm saati gibi yazılmaz. cwd/project health ve çıktı görüntüsü hataları lifecycle'dan ayrıdır. Activity/health/preview diske state olarak yazılmaz.
- Aynı Session lifecycle mutasyonları kilitlidir; çakışma 409 operation_in_progress. Run kimliği eski callback'in yeni koşuyu değiştirmesini engeller. Proje silme yeni create'i bloke eder. PTY liderinin çıkması süreç grubunun bittiğini tek başına kanıtlamaz.

## 3. Başlatma, devam etme ve ortam

### İlk proje ve ilk Run

Proje yokken ana eylem Proje ekle. Hata girilen yolu korur. HEAD yoksa worktree preset'i açıklamayla kapalıdır; shared yalnız bilinçli seçim. Oturum adı isteğe bağlı, 1–80 Unicode karakter, kontrol karakteri yok; boş ad CLI etiketi + kısa id. Kimlik rastgele 128 bit; branch agentdeck/<slug32>-<tam-id>; path yönetilen kök/projectId/sessionId. Kullanıcı adı path veya kimlik değildir.

Worktree create başlangıcında çözümlenmiş HEAD OID'sinden yaratılır ve baseCommit'e yazılır. Kirli ana kopya taşınmaz. `.env`, bağımlılıklar, ignored dosyalar ve servis portları hazırlanmış varsayılmaz; secret otomatik kopyalanmaz, init/install komutu gizlice koşulmaz. Oturum başlığında cwd kopyalama ve kurulum yardımına erişim bulunur.

Preset tıklaması terminali açar. **Üç CLI da yeni bir klasörde güven onayı sorar** — ölçüldü: Claude “Is this a project you trust?”, Codex “Do you trust the contents of this directory?”, Gemini “Do you trust the files in this folder?”. Güven kaydı mutlak yola bağlı olduğu için her yeni worktree bunu yeniden sorar. Bu yüzden ilk açılışta terminal yanında kısa bilgi gösterilir: “Ajan klasör güveni veya giriş onayı isteyebilir; terminalden tamamlayın.” Kullanıcı bunu kapatabilir. Gemini ayrıca “üst klasörü güven” seçeneği sunar; bu kullanıcının kendi tercihidir, uygulama önermez ve yapmaz. Gerçek trust/auth ekranı algılandığı iddia edilmez; “güven onayı bekliyor” otomatik status'u yoktur. CLI onayına Enter gönderilmez, kullanıcı trust/config dosyalarına otomatik kayıt veya bypass bayrağı yazılmaz. Onayı vermeden kapatıp aynı dosyalarda tekrar denemek desteklenen normal akıştır.

### Command ve CLI yetenek sınırı

command:null kullanıcının geçerli SHELL'iyle interaktif login shell; bulunamazsa /bin/bash -l. String komut /bin/bash -lc ile aynen program olarak yürür. Boş string 400. Pipeline, env ataması, expansion ve wrapper geçerli olabilir; AgentDeck bunlara exec/kimlik/resume bayrağı eklemez.

V0 LaunchPolicy izin listesi yalnız **argümansız literal claude, gemini, codex** çağrılarıdır (trim edilmiş eşitlik). Bayraklar, quoted executable, mutlak yol, env öneki ve wrapper genel komut yoluna gider. Böylece --session-file, --from-pr, --list-sessions, --delete-session, --, kısa bayraklar ve gelecekteki CLI seçenekleri AgentDeck tarafından bozulmaz. İleride izin listesi sürüm ve test ile genişletilir; blacklist kullanılmaz. Preset ve aynı literal serbest komut aynı davranışı alır.

İzin listesindeki CLI özellikleri sadece destek matrisiyle doğrulanmış sürümde açılır. Sürüm/help sorgusu kullanıcı programını deneme amacıyla çalıştırmaz; yalnız bilinen CLI'a bounded --version/--help çağrısı, 3 sn/64 KiB, executable/PATH değişiminde cache invalidation. Başarısız veya bilinmeyen sürümde literal komut aynen başlatılır; “bu sürümde yönetilen konuşma devamı doğrulanmadı” bilgisi görünür. Tanınan basename keyfi binary'nin güvenilir olduğu anlamına gelmez; yerel CLI kullanıcı tarafından kurulmuş programdır.

Ölçülen sürümler Claude 2.1.269, Gemini 0.59.0, Codex 0.154.0. Bu turda doğrulananlar: üçünde de yeni klasör güven kapısı; üçünde de etkileşimli seçicinin açılması; Claude'da bilinmeyen kimlikle `--resume`'un etkileşimli TUI'de de `No conversation found with session ID` + exit 1 vermesi; Gemini'nin `--session-id` ile `--session-file` çakışmasını reddetmesi. **Doğrulanmayan:** hiçbir CLI'da insan onayı sonrası konuşma oluşumu ve yönetilen kimlikle geri açılması; Gemini'de auth gerektiren her yol. Bu yüzden yönetilen kimlik hiçbir sürüm için açık doğmaz; desteği doğrulanmamış preset çalışır ama doğrulanmamış özellik açık gösterilmez.

### Kullanıcı eylemleri

1. **Durdur:** süreç grubunu doğrulanmış biçimde durdurur; kayıt, dosyalar, branch ve terminal geçmişi kalır. Timeout başarı değildir.
2. **Yeniden çalıştır:** lastLaunch niyetini tekrarlar. Genel command aynen çalışır; fresh yeni konuşma niyetidir ve destekli Claude/Gemini için yeni UUID üretir; resume aynı açık id'yi hedefler; picker tekrar seçici açar. Bu eylem otomatik olarak fresh'ten resume'a dönüşmez. Legacy lastLaunch yoksa Command aynen çalışır. UI eylem alt açıklamasında bu farkı gösterir.
3. **Konuşmayı sürdür:** V0'da varsayılan yol **CLI'ın kendi etkileşimli seçicisidir** — `claude --resume`, `gemini --resume`, `codex resume`. Üçü de ölçüldü ve çalışıyor; Codex'in seçicisi varsayılan olarak cwd'ye göre filtreliyor, bu worktree-per-session tasarımıyla örtüşüyor. Seçici yolu AgentDeck'in kimlik üretmesini, bayrak enjekte etmesini ve sürüm garantisi vermesini gerektirmez; hangi konuşmanın seçileceği kullanıcının kararıdır, uygulama uydurmaz.

    **Yönetilen kimlik (AgentDeck'in ürettiği UUID ile `fresh`/`resume`) V0'da kapalı doğar.** Bir CLI+sürüm çifti için ancak [G2](agentdeck-v0-validation-gates.md) insan trust/auth testi geçtikten sonra açılır; o zamana kadar o CLI için yalnız literal komut ve seçici sunulur. “Konuşma kimliğiyle sürdür” alanı kullanıcının elindeki açık UUID'yi her zaman kabul eder — bu kullanıcının verisidir, bizim ürettiğimiz değil. `--last`/`--continue` ile otomatik eşleştirme hiçbir koşulda yoktur: bunlar oturum bulunamadığında sessizce yeni konuşma açar.
4. **Aynı dosyalarla yeni konuşma:** kullanıcı açıkça seçer. Aynı Session/cwd/branch/baseCommit, yeni Run; destekli Claude/Gemini'de yeni UUID, Codex'te yeni literal komut. Önceki konuşma CLI arşivinden silinmez. Resume hata çıkışından sonra da bu yol erişilebilir; yeni worktree yaratılmaz.
5. **Bu çalışma kopyasında komut çalıştır:** mevcut çalışmada command string|null için küçük diyalog. Gösterilen cwd korunur, command başlangıç alanı değişmez, başarılı Run lastLaunch.command olur. Böylece CLI seçicisi, explicit resume veya başka ajan kullanılabilir. Ajanlar arasında konuşma bağlamı çevrildiği iddia edilmez.

**Eylemlerin sunumu.** Bu beş yol eşit ağırlıkta listelenmez, aksi halde aynı sonucu veren iki düğme oluşur. Kural: `lastLaunch.mode` **fresh** ise “Yeniden çalıştır” ile “Aynı dosyalarla yeni konuşma” aynı sonucu üretir; bu durumda yalnız “Aynı dosyalarla yeni konuşma” gösterilir. Session'ın bilinen bir konuşma adayı varsa birincil eylem “Konuşmayı sürdür”, “Yeniden çalıştır” ikincildir; aday yoksa birincil eylem lastLaunch niyetini tekrarlayan “Yeniden çalıştır”dır. Birincil olmak yalnız görsel sıradır: hiçbir eylem otomatik çalışmaz, her biri kullanıcı tıklamasıyla başlar ve başlamadan önce ne yapacağını (“aynı konuşmayı sürdürür” / “yeni konuşma açar” / “komutu aynen yeniden çalıştırır”) tek cümleyle söyler.

Canlı Run üzerinde bu eylemler önce doğrulanmış stop gerektirir; kullanıcı canlı işi durduracağını açıkça görür. Slot kendi işlemine rezerve kalır. cwd eksikse yeni Run yok; dizin yaratma/shared fallback yok. Eksik CLI kabuk doğduktan sonra exited olabilir; bunu PTY spawn hatasıyla karıştırma. Spawn veya state commit başarısızsa önceki launch niyeti/kimlik/artefaktlar korunur; live stop olmuşsa exited kalır. Başarılı yeni Run önceki çıktıyı anında yok etmez: güncel ve bir önceki Run artefaktı tutulur; önceki terminal read-only açılabilir. Daha eski tam Run arşivi V0 dışı ve bu sınır UI'da belirtilir. Artefaktlar runId bazlıdır; eski flush yeni Run'ın dosyasını ezemez.

**Codex kararı:** otomatik rollout taraması V0 dışı. Cwd tekil Session yolu olsa da ardışık Run'ları, CLI içi yeni konuşmaları veya dışarıdan aynı dizindeki süreçleri ayırmaz. Dosya biçimi/mtime/en yeni kayıt kesin sahiplik kanıtı değildir. Konuşma bulamama sessiz yeni konuşmaya düşmez; kullanıcı seçici veya fresh eylemini seçer. Hook kurulmaz, CODEX_HOME izole edilmez.

### Ortam sözleşmesi

Her Run güncel login profilini yeniden okur; bunun `.bashrc` içindeki interaktif olmayan erken çıkışı aşacağı veya kullanıcının başka terminalde export ettiği değeri göreceği vaat edilmez. Daemon'ın açıldığı kabuğun tüm env'i PTY'ye kopyalanmaz.

Temel env izin listesi: HOME, USER, LOGNAME, SHELL, PATH, LANG, LANGUAGE, LC_*, TZ, TMPDIR, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_RUNTIME_DIR, DISPLAY, WAYLAND_DISPLAY, XAUTHORITY, DBUS_SESSION_BUS_ADDRESS, SSH_AUTH_SOCK, SSH_AGENT_PID, TERMINFO, TERMINFO_DIRS, COLORTERM; kullanıcı CLI evini korumak için CODEX_HOME, CLAUDE_CONFIG_DIR, GEMINI_CLI_HOME. TERM uygulama tarafından xterm-256color; AGENTDECK_SESSION ve AGENTDECK_RUN her Run'da uygulama tarafından atanır. Parent'ın CLAUDECODE/CLI session işaretçileri, NODE_OPTIONS, ELECTRON_RUN_AS_NODE, BASH_ENV/ENV ve BASH_FUNC_* taşınmaz. Sistem CLI auth dosyaları korunur.

Özel API anahtarı/proxy/PATH ihtiyacı için ~/.config/agentdeck/environment.json düz string değerlerden oluşan kullanıcı dosyası her Run öncesi okunur (yoksa boş; 64 KiB tavan, kullanıcı sahibi, grup/diğer erişimi kapalı). Shell evaluation yoktur; parse/izin hatasında Run başlamaz. Bu dosya yalnız bilinçli kullanıcı yapılandırmasıdır; UI token/env değerlerini okumaz veya loglamaz. TERM ve AGENTDECK_* rezervdir; parent-agent işaretçileri kabul edilmez. Profil dosyaları sonradan değerleri değiştirebilir; kullanıcı tarafından yönetilen davranıştır. API'den rastgele istemci env upload'u yoktur. Yeni profile/env dosyası değişimi sonraki Run'a uygulanır, çalışan sürece enjekte edilmez. Daemon temel env değişimi için kullanıcı tüm işleri durdurup daemon'ı yeniden başlatır; gizli restart yoktur.

## 4. Terminal durumu, önizleme ve protokol

### Tek doğru ekran modeli

node-pty encoding utf8; kanal **çözülmüş UTF-8 terminal metnidir**, keyfi binary'yi kayıpsız koruma garantisi değildir. Bayt bütçesi Buffer.byteLength(text,'utf8') ile ölçülür. Daemon'ın kendi yeniden parçalaması **ne UTF-8 kod noktasını ne de JS surrogate çiftini bölebilir**: bölünmüş bir kod noktası ekranda replacement karakteri üretir (ölçüldü, [kanıt](../research/terminal-state-validation.md)). node-pty varsayılan utf8 modu yalnız PTY okuma sınırını korur, sonraki her parçalamayı değil. ANSI dizileri frame sınırında bölünebilir; terminal parser'ı akış boyunca yaşar. Ham bayt ifadesi kullanılmaz.

Canlı Run için daemon'da headless xterm, istemciyle aynı sürüm/terminal seçenekleri/Unicode genişlik davranışı ile başlangıçtan itibaren tüm çıktıyı sıralı işler. Bir terminal-state worker'ı HTTP/Git kontrol işlerinden ayrıdır; Run başına FIFO, oturumlar arasında sınırlı tur bütçesi kullanır. Paketler worker'a sınırsız postMessage edilmez. Snapshot/read/resize/exit aynı Run sırasına katılır; write callback tamamlanmadan temsil işlenmiş sayılmaz.

İstemci odakta tek görünür xterm kullanır; diff/taramada xterm yok. Bu maliyet tasarrufu daemon ekran durumunu silmez. Odağa dönüşte sırf redraw umuduyla sahte resize yapılmaz. Viewer terminali daemon boyutuyla gösterir (gerekirse scroll); yalnız kontrol sahibi gerçek resize gönderebilir. Resize önce sıralı state emülatörüne, sonra PTY'ye uygulanır; yeni boyut/sequence istemciye gider.

Preview, headless aktif viewport'unun son boş olmayan en çok 8 satırından çıkar; hücre boşlukları ve kelimeler korunur. 2 KiB/preview, en çok 24 görünür kart; kesilme ve capturedAt bilgisi vardır. ANSI/OSC regex silme yolu yoktur. Metin düğümüyle çizilir; link/HTML/pano eylemi üretmez. Ekran modeli hazır değilse “Önizleme hazırlanıyor/erişilemiyor”; uydurma düz çıktı yok. Aynı model TUI ve normal kabuğu besler.

### Snapshot ve canlı devam

Her Run için terminal event sequence monoton artar. Attach auth/protocol/session/run doğrulamasından sonra kayıtlı sıralı stream'e bariyer koyar. Snapshot, işlenmiş son sequence S, cols/rows, formatVersion ve gerekli terminal modlarıyla alınır. S sonrası olaylar abonelik için kayıpsız ve bounded tutulur. İstemci snapshot'ı aynı boyutlarda yazar, sonra S sonrası resize/output olaylarını sırayla işler. Gap, başka daemonId/runId veya snapshot hatası input'u kapatıp yeni attach gerektirir; boş ekrana hatalı delta uygulanmaz.

**Parçalı kontrol dizisi.** serialize ekranı taşır, parser'ın yarım kalmış CSI/OSC/DCS durumunu taşımaz. Bu ölçülmüş bir bozulmadır: bariyer `ESC [ 3` üzerinde kurulduğunda kurulan ekran `ABCD1mRED` olur ve renk kaybolur; yarım OSC'de başlık gövdesi ekrana sızar ([kanıt](../research/terminal-state-validation.md)).

Zorunlu mekanizma iki parçalıdır ve ikisi birlikte uygulanır:

1. **Güvenli kesim.** Emülatöre yalnız son *tamamlanmış* kontrol dizisine kadar veri verilir; yarım kalan ESC prefix'i tüketilmez, bir sonraki yazıma devredilir. Snapshot bariyeri her zaman bu sınırda kurulur.
2. **Bekletilen prefix aktarımı.** Prefix yalnız daemon’da bekler; snapshot’a veya tarayıcıya yarım hâlde verilmez. Sonraki parça diziyi tamamladığında prefix + devam birlikte işlenir ve sorgular ayıklandıktan sonra izleyicilere gönderilir. Gerekçe ve önceki ayrı-alan kararının değişimi [ADR 0008](../adr/0008-terminal-slice-implementation.md) içinde.

Tarayıcı şu sınıfların tamamını tanır ve **on iki sınıfta da ölçüldü**: tamamlanmamış CSI, alt parametreli CSI (`38:2:…`), ara baytlı CSI, tamamlanmamış OSC, gömülü veri taşıyan DCS, APC, PM, 8-bit C1 girişli CSI ve OSC, charset seçimi, yalnız ESC ve tek karakterli ESC. Her sınıfta kurulan ekran kesintisiz referansa eşit çıktı ([kanıt](../research/terminal-protocol-probe.cjs)). Bekleyen prefix için üst sınır **4096 bayt**: geriye tarama bu pencereyle sınırlıdır ve aşılırsa terminal representation hatası açıkça gösterilir, doğru olmayan snapshot yayımlanmaz. Eksik diziyi atarak "başarılı replay" denmez.

**İki katmanlı attach.** Attach'in taşıdığı snapshot varsayılan olarak **yalnız görünür ekrandır**; scrollback ayrı ve isteğe bağlı bir katmandır. Ölçüm farkı büyüktür: dolu bir 1000 satırlık scrollback'te tam snapshot 126 KB / ~11 ms iken yalnız-ekran snapshot 3.8 KB / ~2.8 ms, yani **33 kat küçük**. Yalnız-ekran snapshot görünür ekranı, alternate buffer durumunu, imleci ve terminal modlarını doğru kurar; alternate ekrandan çıkıldığında normal buffer görünümü de referansla aynı kalır (ölçüldü).

Sonuç: oturumlar arasında gezinmek ucuzdur ve **input ilk katmandan sonra açılır**. Kullanıcı geçmişe kaydırmak isterse istemci aynı Run için scrollback katmanını ister ve tam snapshot yeniden uygulanır; bu ikinci katman yalnız açık kullanıcı hareketiyle istenir, her attach'te gönderilmez. Grid önizlemesi de yalnız görünür viewport'a dayandığı için bu katmandan beslenir.

WS mesajları: replay-start(snapshotId,daemonId,sessionId,runId,sequence,cols,rows,formatVersion,scope,totalBytes) — `scope` = `screen` veya `scrollback` —, sıralı replay-chunk(snapshotId,index,text), replay-end(snapshotId,chunkCount), sonra output/resize/run-ended. İstemci reset'i yalnız replay-start'ta yapar; replay-end ve son xterm write callback'i bitmeden input açılmaz. Chunk'ların text payload'u en çok 32 KiB; JSON zarfının **wire** sınırı ayrıca 256 KiB (kaçış karakterlerinin genişlemesi hesaba katılır). Her chunk'ta reset yoktur. Replay total tavanı 8 MiB; bu üst sınır kaynak kabul testinde ölçülür ve gerçek ürün için tekrar gerekçelendirilir.

Replay büyük bir tek send değildir: gönderim wire queue <=1 MiB tutularak parça parça ilerler. Replay boyunca biriken canlı devam kuyruğu 1 MiB'yi aşarsa izleyici 1013 ile ayrılır; PTY öldürülmez. Bir viewer yüzünden üretici bekletilmez. Input text payload <=64 KiB; input wire tavanı 512 KiB. Büyük paste sınırlı parçalanır; kopuşta input otomatik tekrar gönderilmez.

**Terminal cevapları.** Cevap üreten sorguların (DA1/DA2/DSR gibi) tek sahibi **daemon'daki headless terminaldir**; ölçümde bu terminal dördüne de cevap üretti, yani istemci olmasa bile program kilitlenmez.

İstemci tarafında senkron bir "şu an yazıyorum" bayrağıyla ayırmak **çalışmaz**: cevap `write()` çağrısı döndükten sonra, write callback'inden önce asenkron olarak gelir (ölçüldü). Bu yüzden ayrım istemcide değil **sunucuda** yapılır: daemon, giden akıştan cevap üreten sorgu dizilerini **ayıklar**. Bu diziler ekrana hiçbir şey çizmediği için ayıklama görsel olarak kayıpsızdır — ayıklanmış akışla kurulan ekran, tam akışla kurulan ekrana birebir eşit çıktı (ölçüldü).

Sonuç sözleşmesi: tarayıcı terminali hiç otomatik cevap üretmez, dolayısıyla onun `onData`'sından gelen her şey **gerçek kullanıcı girdisidir** ve `lastActivity`'yi haklı olarak ilerletir. Daemon'ın kendi ürettiği cevaplar PTY'ye gider ama aktivite sayılmaz. Paste/mouse/IME davranışı ve gerçek tarayıcı render eşitliği kabul kapısında kalır. OSC clipboard erişimi uygulama tarafından otomatik verilmez; URL açma yalnız kullanıcı hareketiyle allowlist edilmiş http/https üzerinden olur.

### Kaynak ve kalıcılık

Başlangıç: 32 live PTY dahil rezervasyon, 256 Session dahil arşivler. Fazla legacy kayıt kesilmez; yeni create sınır hatası verir. Her headless terminal en çok 1000 normal scrollback satırı; cols 2–300, rows 1–120. Ekran hücreleri/renkler/Unicode maliyeti ham metin baytı değildir; önceki “256 halka ~64 MiB” hesabı bu mimariye kapasite kanıtı olamaz. 32 sayısı sentetik ölçümle sınandı ve **korundu**: 32 headless terminalde etkileşimli profilde RSS 64 MB, write p95 1.4 ms, event-loop p95 5.6 ms; ~8.8 MiB/s toplam yoğun çıktıda RSS 84 MB, write p95 5.2 ms, event-loop p95 5.6 ms (max 20.6 ms), backpressure olayı yok ([ölçüm script'i](../research/terminal-load-probe.cjs)). Emülatör maliyeti bu mimaride engel değildir. Yine de bu sentetik bir ölçümdür: gerçek ajan CLI'ları, browser render'ı ve PTY maliyeti dahil değildir; ürün vaadi 4–8 eşzamanlı gerçek oturumdur, 32 yalnız üst koruma sınırıdır. Run başına bekleyen write sayısı bir high-water eşiğiyle sınırlanır ve eşik aşılınca ilgili PTY pause edilir.

Worker için in-flight UTF-8 kuyruk Run başına 1 MiB, toplam 8 MiB başlangıç tavanı; high/low water ile node-pty pause/resume kullanılır. Bu, emülatörün kendi tüketim baskısıdır ve yalnız ilgili üreticiye uygulanır; yavaş WS viewer ile karıştırılmaz. Hiçbir çıktı sessiz düşürülmez. Uzun süre akış baskısı varsa görünür “çıktı işleniyor” bilgisi ve ölçüm; kontrol endpoint'leri yanıt vermeye devam eder. Worker hata/çöküşünde PTY sırf görüntü hatası diye silinmez; input kapatılır, stop erişilebilir kalır, temsil hatası kaydedilir; durum baştan kurulamadığında sessiz sahte snapshot yoktur.

Run kimlikli terminal checkpoint'leri state.json dışında, özel izinli dosyalarda atomik temp+rename tutulur; içerik format/sürüm/boyut/sequence ile doğrulanır. Dirty olduktan sonra en geç yaklaşık 1 sn'de flush **başlatılır**; devam eden yazım sırasında yalnız bir sonraki dirty iş tutulur, sınırsız queue yoktur. Exit/shutdown işlenmiş son çıktıyı flush eder; fsync/güç kaybı garantisi yoktur, son başarı zamanı görünürdür. Yük altında bir saniyelik mutlak veri kaybı garantisi verilmez.

Terminal Session'larda headless model bellekten bırakılır; checkpoint read-only inspect için lazy yüklenir, en çok iki eşzamanlı yükleme. Son iki Run checkpoint'i tutulur; Session silinince ilgili dosyalar kaldırılır. Eksik legacy geçmiş “önceki görüntü yok”; unreadable/corrupt “önceki görüntü okunamadı”; ikisi ayrı. Eski ham çıktı dosyası yalnız etiketli kısmi geçmiş olarak incelenebilir; doğru ekran checkpoint'i diye migrate edilmez. Orphaned checkpoint'ten görüntü geri gelir; süreç veya CLI konuşması geri gelmiş sayılmaz.

## 5. Tarama, odak ve iş sonucu

Grid tüm projeleri gösterir; sıra createdAt,id ile sabit. Sol Project→Session gezinmesi kalır. Kartta ad/proje, program, lifecycle/activity, cwd/project hata metni, exit bilgisi, branch/shared, ekran preview ve yaş bulunur; renk ikincildir. Metadata filtresi ad/proje/aktif-arşiv durumuyla oturumu bulmayı sağlar; poll focus veya sırayı değiştirmez. Idle hata rozeti gibi gösterilmez; dikkat bilgisi açık hata/orphaned ile ayrılır.

Görünür istemcide tek GET state: önce hemen, önceki istek bitişinden 2 sn sonra; 5 sn timeout, mutation sonrası immediate refresh. daemonId/revision/request generation eski response'u reddeder; activity/preview değişimi aynı revision'da olabilir ve bu nedenle eşit revision cevabı atılmaz. Yaş monotonic sunucu zamanından alınır, istemci monotonic süreyle ilerletir. Gizli sekmede poll durur; dönüşte resync. Health proje/benzersiz cwd başına 2 sn cache, mutation öncesi taze doğrulama.

Odakta Terminal | Değişiklikler. Worktree için varsayılan “Bu çalışma”: baseCommit'ten mevcut tracked çalışma ağacına toplam fark + untracked dosyalar. “Commit edilmemiş”: mevcut HEAD'e göre tracked net fark ve untracked. Staged ve unstaged birbirini geri alıyorsa net patch boş olabilir; status index/worktree durumlarını ayrı belirtir, temiz repo denmez. Shared varsayılan commit edilmemiştir ve bir ajana atfedilmez. Base OID null veya erişilemezse toplam görünüm açıklamayla kapalı; hareketli main/HEAD ile sessiz ikame yoktur.

Diff yalnız sekmeye giriş/Yenile; en çok iki global Git işi; 5 sn/1 MiB patch/50 untracked içerik. Status/path listesi de sınırlıdır (10.000 giriş ve 1 MiB); kesilme görünürdür. Binary/rename/untracked/silinmiş dosya ayrı tanınır. Git error/timeout temiz sayılmaz. Git path'leri NUL ayrılır; argüman dizisi, shell interpolation yok. capturedAt/sessionId/request generation eski cevabı engeller; stale sonuç işaretlenir. CLI dış Git işlemleri sırasında atomik repo snapshot'ı vaat edilmez; başlangıç/bitiş HEAD değişirse stale uyarısı verir.

Terminalde F6 uygulama kromuna çıkar; menü gerçek F6'yı gönderir. Escape/Tab/oklar/kontrol tuşları PTY'de kalır. Krom Escape taramaya döner, modal önce kapanır. Grid/liste roving Tab, okla aday, Enter/Space ile açma; aday değiştirmek PTY açmaz. Açık kullanıcı seçimi sonrası replay hazırken focus; reconnect focus çalmaz. Taramaya dönüş kart/scroll konumunu korur. Silme komşu gezinme hedefine döner, komşu PTY otomatik açılmaz. Dar ekranda drawer focus'u tetikleyene döner. IME, ekran okuyucu ve %200 zoom kabul koşuludur.

## 6. Saklama ve güvenli temizlik

**İşi bitirmenin varsayılan yolu Arşivle.** Live oturumda “Durdur ve arşivle” açıkça söylenir; doğrulanmış stop başarısızsa archive yapılmaz. Archive kayıt/cwd/branch/baseCommit/son terminal görüntülerini tutar, aktif grid'den çıkarır. Arşiv filtresiyle bulunur; “Arşivden çıkar” dosyalara dokunmaz. 256 kayıt sınırında neyin korunduğu açıklanır, otomatik yaş/sayı temizliği yoktur.

**Silme:** ikincil menü eylemi. Worktree dosyaları ve Session kaydı gider, branch kalır. V0 deleteBranch alanı yoktur; eski istemciden gelirse 400, sessiz branch silme yok. Proje “Korunan branch'ler” görünümü isteğe bağlı bounded Git ref okumasıyla agentdeck/ branch adları + tip OID sunar (5 sn, 1000 ref, truncation); Git hata/boş ayrılır. Kayıt yoksa görev metadata'sı uydurulmaz. Branch/yol kopyalama görünürdür; otomatik merge/PR veya branch silme yoktur.

Delete-preview yalnız yetkili istemciye opaque, daemon-ömrüne bağlı, 60 sn TTL onay üretir: Session id/runId, işlem, canonical cwd + dizin kimliği, tracked/index/worktree/untracked içerik fingerprint'i. Symlink'ler izlenmeden link hedef metni hash edilir; dış içerik okunmaz. Hash dosya adı/status/count'tan ibaret değildir. Ignored içerik ayrıca “bu klasördeki ignored dosyalar da silinir (.env ve bağımlılıklar dahil)” uyarısıyla onay kapsamına alınır; alt dizin/symlink/submodule sınırları tanımlı kontrol edilir. Kullanıcı tam cwd'yi görür.

Preview için 5 sn, 10.000 dosya ve 128 MiB okunacak içerik bütçesi (tracked dirty + untracked + ignored toplamı). Herhangi bir aşım/okuma hatası varsa **onay üretilmez**; “Klasör büyük veya okunamıyor; dosyaları yerel araçla inceleyip temizleyin, ardından tekrar deneyin” ve cwd kopyalama sunulur. Ignored dosyalar hash edilmeden “değişmedi” denmez; bütçe aşımında uygulamanın bypass force yolu yoktur. Bu bilinçli güvenlik/kullanılabilirlik dengesi, büyük node_modules klasörüyle pilotta sınanır.

Silme öncesi aynı Session kilidiyle onay doğrulanır, live ise süreç grubu durdurulur, dosya durumu **tekrar** okunur. Değişmişse 409 confirmation_stale, oturum durmuş kalır ve yeni önizleme sunulur. Onay alınmış gibi süreci yeniden başlatma yoktur. Git worktree lock/izin/kimlik hatasında rmSync fallback yok. Dizin veya repo eksikse force/manual path delete yerine kullanıcıya açık kurtarma sonucu verilir. Dış programların check→remove aralığındaki yazımına filesystem transaction garantisi yoktur; tespit edilemeyen yarış riski kabul metninde gizlenmez.

Worktree başarıyla kaldırılıp state yazılamazsa kayıt korunur ve degraded/kısmi sonuç görünür. Proje silme bütün Session'lar için aynı kuralı uygular; kalan varsa Project kalır. Proje onayı Session kümesini, her onay fingerprint'ini ve süreyi bağlar; bir sınırlı bütçeyi N ile gizlice aşmaz, büyük projede tek tek temizleme önerir.

**Orphan:** startup salt okunur keşif (symlink izlemeden, yönetilen kök ve Git metadata sınırıyla). Geçerli eski yedek dahil hiçbir state otomatik silmeye yetki vermez. Açılış taraması 5 sn/10.000 girişle bounded; eksik tarama açık uyarıdır, temiz olduğu sonucu çıkarılmaz. Yetim kayıtlar “Kayıtsız çalışma kopyaları” altında yol/Git metadata'sıyla görünür; UI V0 temizlemez veya otomatik sahiplenmez. Create rollback'i yalnız kendi yeni kaynağı, beklenen kimlik/OID ve hiç değişmemiş içerik doğrulanırsa kaldırır; aksi halde kaynağı korur ve bildirir.

## 7. API, sahiplik ve kalıcılık

REST auth+origin, WS upgrade öncesi auth+origin. Token URL'den alınıp temizlenir; token/log/env içeriği sızdırılmaz. 400 validation, 401 token, 403 origin, 404 yok, 409 çakışma/eski onay/kapasite, 500/503 işlem/kalıcılık. Error {code,message,details?}; kullanıcıya stack trace yok.

- GET /api/health: yalnız app/protocol/pid, tokensız.
- GET /api/state?previewIds=...: protocolVersion:2, daemonId, revision, serverNow/age, projects/sessions, serviceError, bounded preview/error metadata. Preview ve terminal state dosyaları ham state cevabına girmez.
- POST /api/projects {path}; DELETE /api/projects/:id {confirmationToken}; POST /api/projects/:id/delete-preview.
- POST /api/sessions {requestId,projectId,name?,command,isolation}; POST /api/sessions/:id/stop {expectedRunId}; POST /api/sessions/:id/restart {requestId,expectedRunId}; POST /api/sessions/:id/launch {requestId,expectedRunId,mode,command?,cli?,conversationId?}. Mode command|fresh|resume|picker; yalnız modun izinli alanları kabul edilir, serbest ek alanlar reddedilir. Managed mode için LaunchPolicy uygunluğu/sürümü sunucuda kontrol edilir.
- POST /api/sessions/:id/archive {expectedRunId,stopIfLive}; POST /api/sessions/:id/unarchive. Archive canlıysa stopIfLive:true açık eylem gerektirir; aksi 409.
- POST /api/sessions/:id/delete-preview; DELETE /api/sessions/:id {confirmationToken}; branch silme desteklenmez.
- GET /api/sessions/:id/diff?scope=work|uncommitted; GET /api/projects/:id/branches; GET /api/orphan-worktrees (bounded, salt okunur).
- WS /ws?session=id&token=...: live current Run attach veya current/previous Run read-only inspection; inspect request'i runId ile yetkilendirilir. Terminal control yalnız current live Run içindir. Protokol olayları bölüm 4'te.

Create ve yeni Run eylemleri requestId ile bounded dedup: 10 dk, 1024 sonuç/daemon, aynı id+payload aynı sonuç, farklı payload 409. Sonuç kaybında state/daemonId uzlaştırılır; başka daemon veya cache süresi sonrası otomatik retry yok. Mutation body/frame boyutları uygulanır. Aynı old expectedRunId ile geç gelen stop/restart yeni Run'ı etkilemez.

Tek input/resize sahibi: ilk uygun live attach lease alır, viewer salt okunurdur; açık Kontrolü al generation artırır. Eski lease input/resize reddedilir. WS kapanışı lease bırakır; eski izleyici otomatik kontrol kapmaz. Ping 15 sn/pong 10 sn. Snapshot replay ve terminal response sahipliği bu kullanıcı kontrolünden ayrıdır.

Network/state timeout'ta son görünüm stale/salt okunur, input kapalı; yalnız WS kopuşunda uygulama state'i sağlıklıysa sadece terminal bağlantı hatası. 401/403 otomatik retry durur; 5xx “durum okunamadı”, süreç öldü iddiası yok. 2/4/8/10 sn backoff, görünürlük/manuel deneme hemen. Disk hatası serviceError'dür; PTY'ler sırf disk yazımı başarısız diye öldürülmez, yeni kalıcı mutation reddedilir. Görüntü modeli sağlıklıysa mevcut kullanıcı input'u sürer; gerçek exit bellek görünümünde saklanmaz.

Daemon canonical data dizini hash'li Linux abstract socket bind etmeden state'e dokunmaz. Aynı data/farklı port ikinci writer reddedilir; network namespace paylaşımı kapsam dışı. Socket en son bırakılır. Port AGENTDECK_PORT, yoksa legacy PORT, yoksa 4711; launcher aynı değeri kullanır. Yabancı servis/protokol 2 uyuşmazlığında öldürme yok; 20 sn başlatma timeout/log yolu. SIGTERM/INT yeni mutation durdurur, süreç gruplarını stop eder, flush dener; SIGKILL sonrası bilinmeyen live orphaned olur.

State schemaVersion:2. V0 eski agent/status kaydı veya schemaVersion:1 yalnız tanınan doğrulanmış şemayla yedekli atomik migrate edilir. command korunur, baseCommit bilinmiyorsa null, archivedAt null, eski lastLaunch yoksa command niyeti; conversation id varsa yalnız açık adaydır. Run/artefakt referansları doğrulanır, sahte eski runId üretilmez. Bozuk/daha yeni schema, permission error veya state yok+managed kaynak varsa durur; boş state yazma/süpürme yok. Copy-on-write tek yazım kuyruğu, temp+rename sonrası publish. PTY spawn olmuş ama disk commit olmamışsa yalnız kendi create/launch grubu durdurulur; rollback başarısızsa kaynaklar korunur, serviceError ve kurtarma bilgisi görünür. Yeni Run state commit'i eski Run checkpoint'ini silmez.

## 8. Uygulama sırası ve kabul

1. Güvenilir tek Session: schema, tek sahiplik, lifecycle/Run, stop doğrulaması, dosya koruma, salt okunur orphan keşfi. **Uygulandı** (12 Eylül 2026); iki hüküm §8/4'e daraltıldı: silme onayının içerik fingerprint'i ve kademeli proje silme ([ADR 0007](../adr/0007-slice-1-implementation-boundaries.md)).
2. Gerçek bir worktree'de insanın CLI trust/auth ekranını tamamladığı ilk kullanım; onay öncesi stop ve aynı dosyalarda fresh tekrar. Bu test shell/environment ve restart çıkmazını erken yakalar.
3. Headless terminal/snapshot/preview/encoding ve kontrol yanıtları. **Uygulandı:** terminal-state worker’ı, güvenli kesim, sorgu ayıklama, iki katmanlı replay, checkpoint ve odak istemcisi. Gerçek tarayıcı/CLI kabulü açık ([ADR 0008](../adr/0008-terminal-slice-implementation.md)).
4. Çalışma diff'i/baseCommit, aynı cwd'de açık launch, arşiv ve branch bulma; sınırlı/safe delete. **Uygulandı** (13 Eylül 2026); launch yalnız command modunu açar, yönetilen kimlik G2'ye bağlı kalır ([ADR 0011](../adr/0011-work-result-slice-implementation.md)).
5. Grid/odak/klavye/poll entegrasyonu; 4–8 gerçek oturum, sonra 32 sentetik PTY/256 kayıt. **Ürün kodu uygulandı** (13 Eylül 2026); 4–8 gerçek oturum ve 32 sentetik kabulü açık ([ADR 0012](../adr/0012-scan-focus-poll-implementation.md)).
6. Çöküş/disk-full/bozuk state/eski yedek/timeout/çoklu istemci/tekrar istek/Unicode/ANSI/çok büyük dosya ve dış Git yarış kabulü; README ile gerçek davranış hizası.

Kabul senaryoları [doğrulama kapıları](agentdeck-v0-validation-gates.md) içinde numaralıdır. G1 kapandı: sekans kapsamı, sorgu sahipliği, iki katmanlı snapshot, 32 terminal kaynak maliyeti ve gerçek tarayıcı buffer eşitliği ölçüldü. G2'nin insan onayı gerektiren maddeleri açık; bunlar geçmeden hiçbir CLI için yönetilen kimlik açılmaz. G3/G4 ürün kabulüdür ve yapılmadı.

Ölçülenlerin tamamı sentetiktir ve ürünün hatasız olduğunu kanıtlamaz: piksel/font render'ı, paste/mouse/IME, gerçek ajan CLI çıktı profili ve uzun süreli bellek davranışı ölçülmedi.
