# Terminal state görüntünün kaynağıdır

Durum: accepted — 2026-09-13. Ürün kodu [ADR 0008](0008-terminal-slice-implementation.md) ve [ADR 0013](0013-durability-slice-implementation.md) ile girdi; IME/piksel ve 4–8 gerçek CLI kabulü G4'te. Eski `0002-scrollback-session-record.md` kararının yerine geçer: ham halka replay ve ANSI silerek preview üretme hükümleri yürürlükten kalktı.

Her canlı Run, daemon tarafında sıralı UTF-8 çıktıyla beslenen headless xterm durumuna sahiptir. Tek oturum görünümünde istemci odakta tek xterm açar; Terminal grid bu kuralı [ADR 0010](0010-terminal-grid.md) ile yan yana paneller için günceller. Attach, aynı boyutlarda terminal snapshot'ı ve sıralı devam akışı alır. Preview aynı ekran modelinin görünür satırlarından çıkar. Tam terminal emülasyonu yeniden yazılmaz. V0'da ayrı bir ham çıktı halkası **yoktur**: ikinci bir görüntü kaynağı tutmak iki doğruluk kaynağı ve iki bütçe demektir. Ekranın tek kaynağı terminal state, kalıcılığın tek biçimi Run kimlikli checkpoint'tir.

Sütun konumlandırması, imleç ve alternate buffer yalnız ANSI silerek korunamaz. Resize dürtmesi redraw garantisi vermediğinden restorasyon mekanizması değildir. İstemci cache'i yeni istemciye veya uzun kopuşa çözüm olmaz.

Snapshot tek başına yetmez: serialize ekranı taşır, parser'ın yarım kalmış kontrol dizisini taşımaz. Bu yüzden emülatöre yalnız tamamlanmış kontrol dizilerine kadar veri verilir, yarım kalan prefix bekletilir ve replay'den sonraki ilk devam verisi olarak gönderilir. İkisi birlikte zorunludur; yalnız biri bozuk ekran üretir. Bunun bedeli daemon'da sürekli parsing, kaynak bütçesi ve xterm sürüm uyumudur; [terminal doğrulama notu](../research/terminal-state-validation.md) yalnız dar sentetik kanıt taşır. Browser/gerçek CLI/yoğun çıktı kabulü tamamlanmadan ürün hazır sayılmaz.

Snapshot, parçalı replay, parser devamı, terminal yanıt sahipliği ve kaynak hata davranışı [spec](../specs/agentdeck-v0.md#4-terminal-durumu-önizleme-ve-protokol) içindedir. Geçmiş dosyasının okunamaması boş geçmiş diye saklanmaz.

Uygulama güncellemesi: prefix ayrı alanla tarayıcıya verilmez; tamamlanana kadar daemon’da bekletilir. Gerekçe, test ve kapsam [ADR 0008](0008-terminal-slice-implementation.md) içindedir.
