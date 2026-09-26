# Klasör projesinde pull request'ler

Durum: accepted — 2026-09-26, `main` dalında. [ADR 0021](0021-project-pull-requests-and-pr-sessions.md)'deki proje PR sayfasını klasör projelerine genişletir.

**Sorun.** PR sayfası yalnız git projelerinde vardı. Birkaç depoyu tek klasörde tutan kullanıcı (ör. dört depolu `kiosk`), depolarının PR'larını görmek için her depoyu ayrı proje olarak eklemek zorundaydı. Kenar çubuğundaki PR sayısı da ince, açık renkli bir çerçeveydi ve kolay gözden kaçıyordu.

**Karar 1 — Klasör projesinin PR listesi alt depoların birleşimidir.** `GET /api/projects/:id/github/pulls` klasör projesinde Alt depoları tarar (ADR 0009 sınırlarıyla). Her depo için `gh pr list` paralel çalışır; depo başına bir dakikalık önbellek aynıdır. Yanıt şunları içerir:
- `repo` alanıyla işaretlenmiş PR'lar.
- Depo başına durum: `repos[{ path, count, error }]`.
- Taramanın kesilip kesilmediği: `truncated`.

GitHub'a bağlı olmayan depo (`not_github`) veya tek bir deponun hatası listeyi bozmaz; o deponun satırında gösterilir. Hiçbir depo okunamıyorsa ve neden `gh` eksikliği ya da girişin olmamasıysa, git projesindeki gibi o hata döner.

**Karar 2 — PR kimliği depo ve numaradır.** Klasörde iki depoda aynı numaralı PR olabilir. Ayrıntı, taslak/hazır geçişi ve inceleme yayımlama uç noktaları `?repo=<alt-depo>` alır. Depo taramada bulunmalıdır; yoksa `repo_not_found` döner, `..` gibi yollar da böylece reddedilir. Git projesinde yalnız `.` geçerlidir. Arayüzde seçim `{ number, repo }` olarak tutulur. İnceleme taslağı `project:<id>:<repo>` anahtarıyla saklanır, böylece iki deponun #42'si notlarını karıştırmaz.

**Karar 3 — Arayüz depolara göre gruplar.** Liste her Alt depo için bir başlık gösterir: ad, göreli yol, açık PR sayısı. Altında depo durumunu da gösterir: "Açık PR yok" veya "GitHub deposu değil". Arama depo adında da eşleşir; arama veya süzgeç varken boş kalan depo gizlenir. Üst çubukta depo adı görünür; PR seçici "depo · #numara başlık" biçimindedir ve depolar arasında gezer. Kenar çubuğundaki sayı klasörde bütün depoların toplamıdır. Proje menüsü ve palet PR sayfasını klasör projelerinde de açar.

**Karar 4 — Kenar çubuğundaki sayı belirgindir.** Açık PR sayısı dolu yeşil bir hapta, kalın rakam ve "PR" etiketiyle gösterilir.

Bilinen sınırlar:
- Klasör projesinde PR üzerinde ajan başlatılamaz. PR oturumu (ADR 0021) tek depolu worktree ister. Satırdaki eylem bunun yerine PR'ı GitHub'da açar. İnceleme notları seçilen bir terminale yine gönderilebilir.
