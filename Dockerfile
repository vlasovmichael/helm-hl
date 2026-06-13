# ───────────────────────────────────────────────────────────────
#  build-stage: собираем дашборду (Vite). node:22 — Vite 8 требует
#  Node ≥20.19/≥22.12. Тут нужны devDeps (vite), в рантайм они не едут.
# ───────────────────────────────────────────────────────────────
FROM node:22-alpine AS dashboard-build
WORKDIR /app
# better-sqlite3 (prod-dep) на node:22-musl не имеет prebuilt-бинаря → npm ci
# компилит его через node-gyp, которому нужны python3/make/g++. Стейдж выбрасывается
# (в рантайм едет только dist/), так что тулчейн на финальный образ не влияет.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:dash

# ───────────────────────────────────────────────────────────────
#  runtime-stage
# ───────────────────────────────────────────────────────────────
FROM node:20-alpine

# tzdata нужен чтобы переменная TZ (Europe/Warsaw и т.п.) реально применялась.
# Без него alpine молча падает на UTC.
# su-exec нужен entrypoint'у чтобы дропнуть привилегии root → node.
RUN apk update && apk upgrade --no-cache && apk add --no-cache tzdata su-exec
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

WORKDIR /app

ARG INCLUDE_DEV=false
COPY package*.json ./
RUN if [ "$INCLUDE_DEV" = "true" ]; then npm ci; else npm ci --omit=dev; fi

COPY . .

# Собранная дашборда из build-stage (web/ остаётся как исходники, но в проде раздаётся dist/).
COPY --from=dashboard-build /app/src/modules/dashboard/dist ./src/modules/dashboard/dist

RUN mkdir -p data logs && chown -R node:node /app && chmod +x /app/docker-entrypoint.sh

# USER node убран намеренно — стартуем как root, entrypoint выравнивает
# права на bind-mount volume'ы (data/, logs/) и сам переключает в node:1000.
# Лечит "attempt to write a readonly database" при несовпадении UID на хосте.

# Healthcheck — опрос /api/health (публичный, до authGate).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=4 http://127.0.0.1:3010/api/health || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
