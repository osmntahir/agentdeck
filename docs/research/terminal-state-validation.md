# Terminal state kararı için dar doğrulama

Tarih: 2026-09-12. Node 22.19.0, @xterm/headless 6.0.0, @xterm/addon-serialize 0.14.0. Paketler izole geçici dizine kuruldu; ürün `package.json`/lockfile değişmedi. [Tekrarlanabilir script](terminal-state-probe.cjs).

Tekrar: izole geçici dizinde bu iki kesin paket sürümünü `npm install` ile kur; script'i o dizine kopyala ve `node terminal-state-probe.cjs` çalıştır. CLI hesabı veya model çağrısı gerekmez. Bu bir terminal protokol testi alt kümesidir; ürün test takımı değildir. Script'teki bütün beklentiler `assert` ile zorlanır; çıktı yalnız ölçülen değerleri raporlar.

## Gözlem

1. **Sütun konumlandırması.** CSI `\e[<n>G` ile yazılmış `Quick safety check:` satırı headless hücre okumasında ` Quick safety check:` döndü; boşluklar korundu. Aynı akıştan ANSI'yi regex ile silmek `Quicksafetycheck:` üretir. Preview'ın ekran modelinden çıkması bu yüzden gereklidir.
2. **Ham kuyruk ekranı kurmuyor.** Yalnız 10. satırı güncelleyen 330.000 baytlık çıktının **son 262.144 baytı** boş terminale oynatıldığında referans ekrana eşit çıkmadı; alternate buffer'daki `HEADER` kayboldu. Beklenen başarısızlık assertion ile sabitlendi.
3. **Snapshot doğru kuruyor.** `serialize()` çıktısı yeni bir headless terminale uygulandığında görünür ekran, buffer türü (alternate), imleç X/Y ve `terminal.modes` eşitti; iki terminal normal buffer'a döndüğünde ekranlar yine eşitti. Bu fixture'da snapshot 695 UTF-8 bayt, snapshot+restore turu ≈10 ms.

### 4. Bariyer yarım kontrol dizisine denk gelirse snapshot bozulur (yeni)

`serialize()` **ekranı** taşır, parser'ın yarım kalmış CSI/OSC durumunu taşımaz. Ölçüm:

| Akış | Kesintisiz referans | Snapshot'tan kurulan |
| --- | --- | --- |
| `ABCD` + `\e[3` … `1mRED` | `ABCDRED`, fg = 1 (kırmızı) | `ABCD1mRED`, fg = -1 (varsayılan) |
| `XY` + `\e]0;my-ti` … `tle\a ZZ` | `XYZZ` (başlık tüketildi) | `XYtleZZ` (başlık gövdesi ekrana sızdı) |

Yani kalan parça hem **metin olarak ekrana sızıyor** hem de taşıdığı stil/komut kayboluyor. Bu, tasarımın gerçek bir açığıdır ve tek başına "snapshot aldık" demek yetmez.

### 5. Güvenli kesim + bekletilen prefix bunu gideriyor (yeni)

Üretici akışı en kötü yerlerden kesilip **her parçadan sonra** snapshot alınıp yeni terminale devredildiği senaryoda:

- emülatöre yalnız son **tamamlanmış** kontrol dizisine kadar veri verilir; yarım kalan ESC prefix'i bekletilir,
- snapshot bu güvenli sınırda alınır,
- bekletilen prefix, replay bittikten sonraki **ilk devam verisi** olarak gönderilir.

Sonuç kesintisiz referansla eşit çıktı: `ABCDRED ok`, fg = 1. Dört ardışık devirde de eşitlik korundu (assertion).

Script'teki tarayıcı **gösterim amaçlıdır**: tamamlanmış CSI, sonlanmış OSC/DCS/PM/APC, charset seçimi ve tek karakterli ESC'yi tanır. Ürün uygulaması ayrıca 8-bit C1 kontrollerini, gömülü veri taşıyan DCS gövdelerini ve alt parametreli CSI biçimlerini kapsamalı ve bekleyen prefix için bir üst sınır uygulamalıdır.

### 6. Parça sınırı kod noktasını bölmemeli (yeni)

`€` karakterinin UTF-8 baytları iki ayrı `write()` çağrısına bölündüğünde ekranda `U��` oluştu. node-pty varsayılan `utf8` modunda PTY okuma sınırını kendi decoder'ıyla korur; bu risk **daemon'ın kendi yeniden parçalamasında** doğar. Chunk sınırları hem UTF-8 kod noktasını hem de JS surrogate çiftini bölmemelidir.

## Sonuç ve açık sınırlar

Headless state + serialization yönü, ham kuyruğu tekrar oynatma ve kontrol kodlarını silme yöntemlerinden bu fixture'da daha doğru; ve bariyer sorunu için **uygulanabilir, ölçülmüş** bir mekanizma vardır. Bu gözlem şunları kanıtlamaz: tüm ANSI/OSC/DCS sekans kapsamı, browser renderer davranışı, terminal query yanıtlarının sahipliği, 32 eşzamanlı PTY'de CPU/bellek maliyeti ve gerçek ajan TUI'leriyle uçtan uca doğruluk. Bunlar [doğrulama kapısı G1](../specs/agentdeck-v0-validation-gates.md) içindedir.

Resize dürtmesi çözüm olarak seçilmedi: çıktı üretmeyen bir programın resize sonrası redraw yapacağına protokol garantisi yoktur. İstemci cache'i de yeni istemcinin veya uzun kopuşun ekranını kurmaz.

Kaynaklar: [xterm serialize eklentisi](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize), [xterm buffer modeli](https://xtermjs.org/docs/api/terminal/interfaces/ibuffer/), [node-pty encoding tipi](https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts). Kurulu node-pty tipi varsayılan `utf8`/string ile `encoding: null`/Buffer ayrımını açıkça belgeliyor.
