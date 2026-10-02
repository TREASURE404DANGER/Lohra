FROM node:lts-alpine
# yoink plugin: yt-dlp (python zipapp, self-updated at runtime into data/bin) + ffmpeg/ffprobe
RUN apk add --no-cache python3 ffmpeg ca-certificates \
 && wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod 755 /usr/local/bin/yt-dlp && yt-dlp --version
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY test ./test
ENV NODE_ENV=production DATA_DIR=/app/data PLUGINS_DIR=/app/plugins TZ=UTC
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 CMD ["node","src/healthcheck.js"]
CMD ["node","src/index.js"]
