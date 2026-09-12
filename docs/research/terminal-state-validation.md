# Terminal state kararı için dar doğrulama

Tarih: 2026-09-12. Node 22.19.0, @xterm/headless 6.0.0, @xterm/addon-serialize 0.14.0. Paketler izole geçici dizine kuruldu; ürün `package.json`/lockfile değişmedi. [Tekrarlanabilir script](terminal-state-probe.cjs).

Tekrar: izole geçici dizinde bu iki kesin paket sürümünü `npm install` ile kur; script'i o dizine kopyala ve `node terminal-state-probe.cjs` çalıştır.

**Güncelleme (12 Eylül 2026, §8/1 dilimi):** yukarıdaki ölçüm anındaki durum korunmuştur — o gün paketler izole dizine kurulmuştu. Bugün `@xterm/headless` ve `@xterm/addon-serialize` aynı sabit sürümlerle depo devDependency'sidir; tekrar için kopyalama gerekmez, depo kökünden `node docs/research/terminal-state-probe.cjs` yeterlidir. Bu paketler hâlâ **üretim** bağımlılığı değildir; terminal-state worker'ı (§8/3) uygulanınca oraya taşınacaktır. CLI hesabı veya model çağrısı gerekmez. Bu bir terminal protokol testi alt kümesidir; ürün test takımı değildir. Script'teki bütün beklentiler `assert` ile zorlanır; çıktı yalnız ölçülen değerleri raporlar.

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


## G1 ölçüm turu — 12 Eylül 2026

İki ek script: [protokol](terminal-protocol-probe.cjs) ve [yük](terminal-load-probe.cjs). Aynı izole kurulum, aynı sürümler.

### Sekans kapsamı — geçti

Güvenli kesim tarayıcısı on iki sınıfta sınandı: tamamlanmamış CSI, alt parametreli CSI (`38:2:…`), ara baytlı CSI, tamamlanmamış OSC, gömülü veri taşıyan DCS, APC, PM, 8-bit C1 girişli CSI ve OSC, charset seçimi, yalnız ESC, tek karakterli ESC. Her sınıfta bekletilen prefix aktarımıyla kurulan ekran kesintisiz referansa **eşit**. Geriye tarama penceresi 4096 baytla sınırlandı.

### Terminal sorgu sahipliği — mekanizma belirlendi

- Headless terminal DA1, DA2, DSR-cursor ve DSR-status sorgularının **dördüne de** cevap üretiyor (`onData`). Yani istemci bağlı olmasa bile sorgu soran program kilitlenmez.
- Cevabın zamanlaması ölçüldü: `write()` **döndükten sonra**, write callback'inden **önce**. Sıra `['write-döndü','cevap','callback']`. Dolayısıyla istemcide "şu an write içindeyim" senkron bayrağıyla ayırmak güvenilir değil.
- Seçilen çözüm: daemon giden akıştan sorgu dizilerini **ayıklar**. Ekranı değiştirmiyor — ayıklanmış akışla kurulan ekran tam akışla kurulana birebir eşit; tarayıcı terminali sıfır otomatik cevap üretti; gerçek kullanıcı girdisi (`input('x')`) geçmeye devam etti.

### İki katmanlı snapshot — 33× kazanç

Dolu 1000 satırlık scrollback üzerinde:

| Katman | Boyut | Süre |
| --- | --- | --- |
| Yalnız ekran (`scrollback: 0`) | **3.8 KB** | 2.8 ms |
| Tam scrollback | 126 KB | ~11 ms |

Yalnız-ekran snapshot görünür ekranı, alternate buffer türünü, imleç konumunu ve modları doğru kurdu; alternate ekrandan çıkıldığında normal buffer görünümü de referansla aynı kaldı. Attach'in varsayılanı bu yüzden ekran katmanıdır.

### Gerçek tarayıcı eşitliği — geçti

`@xterm/headless` 6.0.0 ile üretilen yalnız-ekran snapshot (496 B), gerçek Chrome'da `@xterm/xterm` 6.0.0 derlemesine yazıldı ve karşılaştırıldı ([script](terminal-browser-parity.cjs)):

```
[PARITY] {"satirEsit":true,"farkliSatir":[],
          "bufferTuru":{"headless":"alternate","browser":"alternate"},
          "imlec":{"headless":[4,11],"browser":[4,11]},
          "modFarki":[],"SONUC":"PARITY_PASS"}
```

Fixture kapsamı: normal buffer geçmişi, alternate ekran, CSI sütun konumlandırma, truecolor ön plan, 256-renk arka plan, CJK wide karakter, combining aksan, emoji, altı çizili/italik/ters stiller, bracketed paste ve application cursor modları, belirli imleç konumu. 20 satırın tamamı eşit, imleç eşit, mod farkı sıfır.

Sınır: bu **buffer durumu** eşitliğidir. Piksel render'ı, font/ligature davranışı, paste/mouse/IME etkileşimi ve WebGL/canvas renderer farkları ölçülmedi.

### 32 terminal kaynak maliyeti

120×32, scrollback 1000, Node 22.19.0, bu makine:

| Profil | Akış | RSS | heap | write p95 | event-loop p95 (max) | backpressure |
| --- | --- | --- | --- | --- | --- | --- |
| Etkileşimli (TUI yeniden çizimi) | 0.2 MiB/s | 64 MB | 13 MB | 1.4 ms | 5.6 ms (6.3) | 0 |
| Yoğun (derleme logu) | 8.8 MiB/s | 84 MB | 21 MB | 5.2 ms | 5.6 ms (20.6) | 0 |

Scrollback satır sayısının snapshot maliyeti doğrusal: 200 satır ≈ 28 KB, 500 ≈ 65 KB, 1000 ≈ 126 KB, 2000 ≈ 248 KB (terminal başına, dolu normal buffer). 1000 satır korundu; iki katmanlı attach zaten bu maliyeti her attach'ten çıkarıyor.

**Sınırlar.** Hepsi sentetiktir. Gerçek ajan CLI çıktı profili, node-pty maliyeti, browser render'ı ve uzun süreli bellek davranışı dahil değildir. Bu ölçümler kapasite garantisi değil, *mimarinin engel olmadığının* kanıtıdır; 32 üst koruma sınırı olarak kalır, ürün vaadi 4–8 oturumdur.

## G2 ölçüm turu — gerçek CLI çıktısı

### Kart önizlemesi gerçek TUI'de okunabilir

Üç CLI'ın gerçek PTY çıktısı (TERM=xterm-256color, 100×30) yakalanıp iki yöntemle önizlemeye çevrildi ([script](preview-readability-probe.cjs)):

| CLI | Headless ekran modeli | Naif ANSI temizliği |
| --- | --- | --- |
| Claude 2.1.269 | okunabilir, yapışık öbek 0 | **bozuk** — `ClaudeCode'llbeabletoread,…` |
| Codex 0.154.0 | okunabilir, yapışık öbek 0 | **bozuk** — `Doyoutrustthecontents…` |
| Gemini 0.59.0 | okunabilir, yapışık öbek 0 | bozulmuyor |

Dürüst nüans: naif yöntem **her CLI'da bozulmuyor**. Gemini metni kutu kenarlığı içine gerçek boşluklarla yazıyor; Claude ve Codex ise kelimeleri sütun konumlandırmasıyla yerleştiriyor. Yani "ANSI silmek her zaman bozar" yanlış olur — doğru ifade: ölçülen üç CLI'ın ikisinde bozuyor, ekran modeli üçünde de doğru. Ölçüt olarak boşluk oranı kullanılamıyor (naif çıktıdaki kutu çizgisi artıkları oranı şişiriyor); 18+ harflik boşluksuz öbek sayısı kullanıldı.

### LaunchPolicy izin listesi

Referans uygulama ve 27 vakalık test [ayrı script'te](launch-policy-probe.cjs). Yönetilen kabul edilen tek biçim: trim edilmiş, tek literal token, tanınan CLI adı. `gemini --session-file`, `--list-sessions`, `claude --from-pr`, `codex resume`, quote içi `resume`, `--` sonrası prompt, env öneki, wrapper, mutlak yol, pipeline, `&&`, `$()`, newline ve büyük harfli/benzer isimlerin tamamı kabuk yoluna gidiyor. Ayrıca doğrulanmamış CLI'da `fresh`/`resume` eylemlerinin açılmadığı assertion'la sabit.

## Sonuç ve açık sınırlar

Headless state + serialization yönü, ham kuyruğu tekrar oynatma ve kontrol kodlarını silme yöntemlerinden bu fixture'da daha doğru; ve bariyer sorunu için **uygulanabilir, ölçülmüş** bir mekanizma vardır. G1 turundan sonra terminal temsili kararı **ölçülmüş** sayılır: sekans kapsamı, sorgu sahipliği, iki katmanlı snapshot, kaynak maliyeti ve tarayıcı buffer eşitliği. Açık kalanlar dar ve adlandırılmış: piksel/font render'ı ile paste/mouse/IME etkileşimi, ve gerçek ajan CLI'larıyla uçtan uca doğruluk (bu ikincisi G2'nin işi). Bunlar [doğrulama kapısı](../specs/agentdeck-v0-validation-gates.md) içinde kalır ve hiçbiri mimari kararı yeniden açmaz.

Resize dürtmesi çözüm olarak seçilmedi: çıktı üretmeyen bir programın resize sonrası redraw yapacağına protokol garantisi yoktur. İstemci cache'i de yeni istemcinin veya uzun kopuşun ekranını kurmaz.

Kaynaklar: [xterm serialize eklentisi](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize), [xterm buffer modeli](https://xtermjs.org/docs/api/terminal/interfaces/ibuffer/), [node-pty encoding tipi](https://github.com/microsoft/node-pty/blob/main/typings/node-pty.d.ts). Kurulu node-pty tipi varsayılan `utf8`/string ile `encoding: null`/Buffer ayrımını açıkça belgeliyor.
