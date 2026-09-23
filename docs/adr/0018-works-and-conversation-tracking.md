# İşler ve Claude konuşma takibi

Durum: accepted — 2026-09-23, `feat/session-conversations` dalında. Spec'in Codex kararında geçen "hook kurulmaz" ilkesinin karşılığı Claude için tersine döner: Claude'a tek bir kanca kurulur. Codex ve Gemini'de ilke aynen sürer.

**Sorun.** Claude Code'da `/rename` ile verilen ad bir kapsayıcıya bağlı değildir. `/clear` yeni bir konuşma kimliği açar ve ad bu yeni konuşmaya kopyalanır. `claude --continue` ise klasördeki en son konuşmayı açar. Kullanıcının makinesinde "ekran yirtilmasi" adı beş ayrı transcript'te görüldü. Bunların ikisi aslında çoklu dil işiydi. Codex ve Gemini de konuşmayı modeller, işi modellemez. AgentDeck'te Session tek bir terminaldir. Bu yüzden aynı amaç için açılan terminalleri ve konuşmaları bir arada gösterecek bir üst birim yoktu.

**Karar 1 — İş.** `Work { id, projectId, name, createdAt }` kalıcı kayda eklenir (`works`, isteğe bağlı alan). Session'a isteğe bağlı `workId` eklenir. Şema sürümü değişmez: alan yoksa iş de yoktur. İşin kaldırılması yalnız kaydı siler ve Session'ları işsiz bırakır. Proje silinince projenin işleri de silinir. Yeni oturum penceresi, görünen oturumun işini önceden seçer. Grid'deki kopya ve paletten hızlı başlatma da o işte açılır. Yan işin yanlış yere düşmesini bu engeller.

**Karar 2 — Konuşma kaydı kancayla gelir.** Kullanıcının Claude `settings.json` dosyasına tek bir `SessionStart` kancası eklenir. Dosya `CLAUDE_CONFIG_DIR` varsa oradadır, yoksa `~/.claude` altındadır. Kanca AgentDeck dışında stdin'i tüketip çıkar. AgentDeck Run'ında `AGENTDECK_HOOK_DIR` altına `<session>.<run>.<pid>.json` bırakır. Daemon dizini izler, olayı oturuma yazar ve dosyayı siler. Kanca stdout'a yazmaz, çünkü SessionStart çıktısı Claude bağlamına eklenirdi. Ağ çağrısı da yapmaz, bu yüzden token veya port bilmesi gerekmez.

Değerlendirilen seçenekler:
- *Ekran çıktısından okumak*: Mevcut resume footer tespiti yalnız çıkışta basılan son kimliği yakalar. `/clear` öncesi konuşma kaybolur.
- *Transcript dizinini taramak*: Ortak klasörde birden çok oturum aynı `~/.claude/projects/<cwd>` dizinine yazar. Hangi dosyanın hangi terminale ait olduğu kanıtlanamaz.
- *`claude --settings` enjekte etmek*: Komut aynen çalışır ilkesini bozar. Kabukta elle yazılan `claude` komutunu da kaçırır.

Ayar dosyası okunamıyorsa veya beklenmedik biçimdeyse dosyaya dokunulmaz ve takip kapalı kalır (`conversationTracking.message`). Symlink ayar dosyası symlink olarak kalır. Kullanıcının diğer kancaları korunur. İşaret metnini (`AGENTDECK_HOOK_DIR`) içeren eski giriş güncel komutla değiştirilir.

**Özet.** Konuşmanın ilk ve son istemi ile `/rename` adı transcript'ten artımlı okunur: yalnız sona eklenen baytlar taranır. Okuma arka planda yapılır ve hiçbir istek onu beklemez. Ad /clear ile kopyalandığı için arayüz konuşmayı ada göre değil isteme göre adlandırır.

**Sürdürme.** Konuşma, görüldüğü oturumda `claude --resume <id>` komutuyla açılır. O oturum çalışıyorsa ve ortak klasördeyse aynı klasörde yeni bir terminal açılır. İzole kopyadaysa kullanıcıdan önce oradaki programı durdurması istenir, çünkü Claude konuşmaları klasöre bağlıdır. Açık olan konuşma ikinci kez sürdürülmez, yalnız terminali açılır.

**Karar 3 — Claude arka plan oturumları işe bağlanır.** Claude Code'un agent görünümündeki arka plan oturumları (`claude agents`) bir İş'e bağlanabilir. Liste CLI'ın betik arayüzü `claude agents --json --all --cwd <proje>` komutuyla okunur; proje alt klasörlerindeki oturumlar da listelenir. Özet satırı ve son güncelleme yalnız varsa `jobs/<id>/state.json` dosyasından eklenir. Bu dosya CLI'ın iç biçimi olduğu için okunamazsa alan boş kalır. İş kaydı yalnız kısa kimlikleri tutar (`claudeSessions`). Bir oturum tek işe bağlıdır: başka işe bağlanırsa eskisinden çıkar. Durum görünümü önbellekteki listeyi kullanır ve eskiyse arka planda tazeler. Listede görünmeyen bağlı oturum `unknown` olarak gösterilir, silinmiş sayılmaz. "Aç" düğmesi iş içinde `claude attach <id>` çalıştıran bir terminal açar. Aynı oturumu izleyen canlı bir terminal varsa ikinci attach açılmaz, o terminale geçilir. Terminali kapatmak Claude oturumunu durdurmaz.

**Sınırlar.** Kanca kurulmadan önce açılmış Claude süreçleri bildirim yapmaz. Codex ve Gemini konuşmaları kaydedilmez. İş arşivi yoktur. Oturumlarının hepsi bitmiş iş kenar çubuğundan çekilir ama taramada görünmeye devam eder.
