# Node 22 on Debian slim. 22 (not 20) ships a global WebSocket, which recent
# @supabase/supabase-js requires at createClient time. Slim (not alpine) also
# keeps native modules painless when `sharp` is added in the follow-up.
FROM node:22-slim

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
