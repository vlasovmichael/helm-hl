FROM node:20-alpine

RUN apk update && apk upgrade --no-cache

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev || npm install --production

COPY . .

USER node

CMD ["node", "src/index.js"]