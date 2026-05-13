FROM node:20-alpine

RUN apk update && apk upgrade --no-cache

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --production

COPY . .

RUN mkdir -p data logs && chown -R node:node /app

USER node

# Healthcheck — опрос /api/health (публичный, до authGate).
# wget доступен в alpine через busybox без доп. пакетов.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- --tries=1 --timeout=4 http://127.0.0.1:3010/api/health || exit 1

CMD ["node", "src/index.js"]