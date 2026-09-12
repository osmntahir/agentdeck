#!/usr/bin/env bash
# G2 kabul testi — insan onayı gerektiren maddeler.
#
# Bu adımları ajan yapamaz: trust/auth onayı kullanıcıya aittir ve onun yerine
# verilmiş gibi kaydedilmemelidir. Betik yalnız ortamı hazırlar, seni doğru
# sırayla yürütür ve sonucu kaydeder.
#
#   bash docs/research/g2-human-acceptance.sh [repo-yolu]
#
# Yaptıkları: HEAD'den geçici bir git worktree açar, seçtiğin CLI'ı orada
# başlatır, sen onayı verip tek bir prompt çalıştırırsın, sonra konuşmanın
# gerçekten oluşup oluşmadığını ve geri açılıp açılmadığını kontrol eder.
# Hiçbir şey silmez; temizliği sonda sana sorar.
set -uo pipefail

REPO="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
REPO="$(cd "$REPO" && git rev-parse --show-toplevel)" || { echo "Git deposu değil: $REPO"; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"
WT="${TMPDIR:-/tmp}/agentdeck-g2-$STAMP"
BRANCH="agentdeck-g2/$STAMP"
LOG="$REPO/docs/research/g2-results-$STAMP.md"

echo "Depo      : $REPO"
echo "Worktree  : $WT"
echo "Branch    : $BRANCH"
echo "Sonuç     : $LOG"
echo
read -rp "Bu worktree'yi oluşturayım mı? [e/H] " a; [[ "$a" =~ ^[eE] ]] || exit 0
git -C "$REPO" worktree add -b "$BRANCH" "$WT" HEAD >/dev/null || exit 1

{
  echo "# G2 kabul testi — $STAMP"
  echo
  echo "Makine: \`$(uname -sr)\`  ·  Worktree: \`$WT\`"
  echo
  echo "| CLI | Sürüm | Güven ekranı | Konuşma oluştu | Açık kimlikle resume | Not |"
  echo "| --- | --- | --- | --- | --- | --- |"
} > "$LOG"

for CLI in claude codex gemini; do
  command -v "$CLI" >/dev/null || { echo "| $CLI | (PATH'te yok) | - | - | - | atlandı |" >> "$LOG"; continue; }
  VER="$("$CLI" --version 2>/dev/null | head -1 | tr -d '\n')"
  echo
  echo "==================== $CLI ($VER) ===================="
  read -rp "Bu CLI'ı test edeyim mi? [e/H] " a; [[ "$a" =~ ^[eE] ]] || { echo "| $CLI | $VER | - | - | - | atlandı |" >> "$LOG"; continue; }

  echo
  echo "ŞİMDİ SEN YAPACAKSIN:"
  echo "  1. Açılan ekranda klasör güveni / giriş onayını TAMAMLA."
  echo "  2. Tek bir prompt çalıştır, örn: 'a.txt dosyasına merhaba yaz'."
  echo "  3. CLI'dan çık."
  read -rp "Hazırsan Enter'a bas… " _
  ( cd "$WT" && "$CLI" )

  read -rp "Güven/giriş ekranı çıktı mı? [e/h] " TRUST
  read -rp "Prompt çalıştı ve dosya değişti mi? [e/h] " WORKED

  # Konuşma kaydı gerçekten oluştu mu?
  FOUND="hayır"
  case "$CLI" in
    claude)
      SLUG="$(printf '%s' "$WT" | sed 's/[^a-zA-Z0-9]/-/g')"
      ls "$HOME/.claude/projects/$SLUG"/*.jsonl >/dev/null 2>&1 && FOUND="evet ($(ls "$HOME/.claude/projects/$SLUG"/*.jsonl | wc -l) transcript)" ;;
    codex)
      if grep -rl --include='rollout-*.jsonl' -F "\"cwd\":\"$WT\"" "$HOME/.codex/sessions" 2>/dev/null | head -1 | grep -q .; then
        FOUND="evet (rollout)"; fi ;;
    gemini)
      ( cd "$WT" && gemini --list-sessions 2>/dev/null | grep -qE '^\s*1\.' ) && FOUND="evet (--list-sessions)" ;;
  esac
  echo "Konuşma kaydı: $FOUND"

  echo
  echo "Şimdi AÇIK KİMLİKLE geri açmayı dene. Aşağıdaki komutu kendin çalıştır,"
  echo "konuşmanın gerçekten kaldığı yerden devam ettiğini gör, sonra çık:"
  case "$CLI" in
    claude) echo "    cd $WT && claude --resume   # listeden az önceki oturumu seç" ;;
    codex)  echo "    cd $WT && codex resume      # Cwd filtresiyle açılır" ;;
    gemini) echo "    cd $WT && gemini --list-sessions && gemini --resume <uuid>" ;;
  esac
  read -rp "Denedin mi, konuşma devam etti mi? [e/h] " RESUMED
  read -rp "Not (boş bırakabilirsin): " NOTE
  echo "| $CLI | $VER | $TRUST | $FOUND | $RESUMED | ${NOTE:--} |" >> "$LOG"
done

{
  echo
  echo "## Karar"
  echo
  echo "Yönetilen kimlik (AgentDeck'in ürettiği UUID ile fresh/resume) yalnız"
  echo "yukarıdaki satırında **güven ekranı = e**, **konuşma oluştu = evet** ve"
  echo "**resume = e** olan CLI+sürüm çifti için açılır. Diğerlerinde yalnız"
  echo "literal komut ve CLI'ın kendi seçicisi sunulur."
  echo
  echo "Bu sonuç \`docs/specs/agentdeck-v0-validation-gates.md\` G2 bölümüne işlenmelidir."
} >> "$LOG"

echo
echo "Sonuç yazıldı: $LOG"
cat "$LOG"
echo
read -rp "Geçici worktree'yi kaldırayım mı? (branch $BRANCH kalır) [e/H] " a
if [[ "$a" =~ ^[eE] ]]; then
  git -C "$REPO" worktree remove --force "$WT" && echo "kaldırıldı: $WT"
else
  echo "duruyor: $WT   (elle: git -C $REPO worktree remove $WT)"
fi
