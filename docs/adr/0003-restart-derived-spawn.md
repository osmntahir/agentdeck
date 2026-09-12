# Yeniden çalıştırma ile konuşmayı sürdürme ayrı eylemlerdir

Durum: accepted — 2026-09-12 revizyonu. “İlk koşu session-id, her sonraki koşu resume” ve bayrak düşürme kararları yürürlükten kaldırıldı.

Her eylem aynı Session/worktree/baseCommit üzerinde yeni Run oluşturur. Restart en son açıkça seçilmiş launch niyetini tekrarlar; fresh türünde her başarılı yeni Run denemesi yeni konuşma kimliği alır, resume türünde hedef kimlik korunur. PTY doğması konuşma oluştu anlamına gelmez. Başarısız veya kayıp konuşmada sessiz fresh fallback yoktur; “Aynı dosyalarla yeni konuşma” her zaman bilinçli çıkış yoludur. “Bu çalışma kopyasında komut çalıştır” genel yoluyla CLI seçicisi veya başka ajan da kullanılabilir; model arası konuşma aktarımı vaat edilmez.

V0 argümansız Claude/Gemini için test edilen sürümde açık id ile resume denemesi sunabilir; kimlik bir adaydır, erişilebilirlik garantisi değil. Codex için belgeli etkileşimli resume seçicisi ve kullanıcı tarafından sağlanan açık id yolu kullanılır. Rollout dosyalarını cwd/en yeni dosya ile otomatik eşleştirme V0'da bilinçli olarak kullanılmaz: aynı worktree'de birden çok Run, iç CLI konuşması veya dış süreç olabilir. Kullanıcı auth/config evleri değiştirilmez.

Terminal artefaktları Run kimliğiyle tutulur; başarısız yeni çalıştırma önceki çıktıyı hemen yok etmez. [Spec](../specs/agentdeck-v0.md#3-başlatma-devam-etme-ve-ortam).
