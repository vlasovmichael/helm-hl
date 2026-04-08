FROM node:20-alpine

RUN apk update && apk upgrade --no-cache

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --production

COPY . .

RUN mkdir -p data logs && chown -R node:node /app

USER node

CMD ["node", "src/index.js"]