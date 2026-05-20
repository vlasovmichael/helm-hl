#!/bin/sh
set -e

# Запускаемся от root → чиним права на bind-mounted volume'ы (data, logs).
# На хосте файлы могут оказаться с другим UID (например root после ручного chown,
# или 1001 если хост-оператор не совпадает с 1000). Контейнер всегда работает как
# node:1000, поэтому ровно перед стартом выравниваем владельца.
#
# Без этого SQLite ловит "attempt to write a readonly database", бот не пишет
# в history, а dashboard потом ошибочно показывает бот'овские сделки как MANUAL
# (reconstructManualTrades не находит их в getHistorySince — и принимает за ручные).

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data /app/logs 2>/dev/null || true
  exec su-exec node:node "$@"
fi

exec "$@"
