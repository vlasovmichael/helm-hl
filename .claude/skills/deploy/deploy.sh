#!/usr/bin/env bash
# Выкатка hl-paper-scanner на Oracle. Без аргументов — полный цикл.
#   ./deploy.sh          проверка → pull → build → up → логи
#   ./deploy.sh --check  только логи прода, ничего не трогает
set -euo pipefail

REMOTE="ssh oracle"
APP="cd ~/hl-paper-scanner &&"

logs() {
  echo "── последние строки ──"
  $REMOTE "docker logs --tail 12 hl-paper-scanner 2>&1"
  echo "── ошибки за 300 строк ──"
  # Фильтр узкий намеренно: WARN тут штатный шум, а не повод отменять выкатку.
  $REMOTE "docker logs --tail 300 hl-paper-scanner 2>&1" |
    grep -iE "ERROR|crash|refus|EACCES|SQLITE" || echo "чисто"
}

if [[ "${1:-}" == "--check" ]]; then logs; exit 0; fi

echo "── локальные тесты ──"
npm test >/dev/null || { echo "❌ тесты красные — выкатка отменена"; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ есть незакоммиченное: прод тянет из git, локальная папка не в счёт"
  git status --short
  exit 1
fi
git push -q origin main

echo "── pull ──"; $REMOTE "$APP git pull -q origin main && git log --oneline -1"
echo "── build ──"; $REMOTE "$APP docker compose build -q hl-paper-scanner"
echo "── up ──";    $REMOTE "$APP docker compose up -d hl-paper-scanner"

sleep 25
logs
