# Node 20 on Debian slim. Slim (not alpine) keeps native modules painless when
# `sharp` is added for image downscaling in the follow-up.
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching.
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
# Cloud Run injects PORT (default 8080); index.js honors it.
EXPOSE 8080

CMD ["node", "index.js"]
