FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends aapt unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=3000 APK_DIR=/apks
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -p /apks && chown -R node:node /app /apks
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
