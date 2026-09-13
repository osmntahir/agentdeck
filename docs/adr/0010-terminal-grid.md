# Terminal grid: birden çok etkileşimli terminal yan yana

Durum: accepted — 2026-09-13. [Spec §4](../specs/agentdeck-v0.md), [ADR 0004](0004-terminal-state-and-scrollback.md) ve [ADR 0008](0008-terminal-slice-implementation.md) içindeki "istemci odakta tek xterm tutar" hükmünü grid görünümü için günceller.

Kullanıcı paralel ajanları aynı anda izleyip yönetmek istiyor; önizleme kartları bunu karşılamıyor. Bu yüzden tek oturum görünümünün yanına ayrı bir **Terminal grid** görünümü eklendi. Tek oturum görünümü ve diff'e geçince terminali bırakma kuralı değişmedi.

**Yerleşim.** Döşeme paneller (`dockview-react`) kullanılır: terminaller boşluk bırakmadan alanı doldurur. Sekme başka bir panelin kenarına bırakılarak bölünür, ortasına bırakılarak sekme olur; aradaki çizgi sürüklenerek boyutlandırılır. Yüzen ve ayrı pencereye çıkan gruplar kapalıdır. Serbest ızgara (dashboard) seçeneği, terminaller arasında boşluk bıraktığı için seçilmedi.

**Ekleme.** Oturumlar grid'e elle eklenir: kenar çubuğundan veya karttan sürükleyerek ya da "Grid'e ekle" ile. Canlı oturumların kendiliğinden eklenmesi seçilmedi. Paneli kapatmak oturumu durdurmaz. Kaydı silinen oturumun paneli kapanır.

**Maliyet sınırı.** Aynı anda en çok 8 panel açılır. Bir grupta sekme olarak gizlenen panelde xterm ve WebSocket açık tutulmaz; sekme öne gelince ekran daemon'daki terminal state'ten kurulur. Böylece açık xterm sayısı ekranda görünen panel sayısını aşmaz.

**Kayıt.** Yerleşim yalnız istemcide (`localStorage`) tutulur; daemon state'ine girmez. Masaüstü uygulaması ve tarayıcı ayrı yerleşim tutar. Okunamayan yerleşim atılır ve grid boş başlar; oturumlar etkilenmez.

**Kontrol devri.** Kontrol mesajı `vacant` alanını taşır: lease'in sahibi yoksa `true`. İstemci kontrolü yalnız sahipsizken kendiliğinden alır. Sahibi olan lease'i almak yine açık "Kontrolü al" eylemidir; ADR 0008'in bu kuralı değişmedi. Neden: grid ile tek görünüm arasında geçerken aynı Run'a yeni bağlantı, eski bağlantının kapanışı sunucuya ulaşmadan gelebilir. O durumda yeni terminal izleyici olarak kalıyor ve sahip ayrıldıktan sonra kimse girdi gönderemiyordu. Birden çok izleyici aynı anda sahipsiz lease'i isterse son istek kazanır; diğerleri salt okunur kalır.

Klavye döşemesi (13 Eylül): gezinme çubuğunda aday seçilir; “Seçilen panelin
yerleşimi” diyaloğunda başka panelin soluna/sağına/üstüne/altına bölünür veya
aynı gruba sekme olarak taşınır. Grup 40 piksel adımlarla boyutlandırılır;
Dockview komşu grup ve alan sınırlarını uygular. Panel kapatma yalnız görünümü
kaldırır. Escape/Bitti tetikleyene döner; son panel kapanmışsa yaşayan krom
odağı alır. Terminal tuşlarına yeni yerleşim kısayolu atanmaz.

Kayıt okunurken 1 MiB metin, 8 panel ve panel/Session kimlik tutarlılığı portal
açılmadan denetlenir; bozuk/aşırı kayıt atılır. Grid'in derin şeması Dockview
`fromJSON` tarafından ayrıca doğrulanır.

Açık kalan: gerçek tarayıcıda 4–8 canlı ajan CLI ile yük ve kullanıcı kabulü.
Kabuk fixture'larıyla Chromium duman testi bu kabulün yerine geçmez.
