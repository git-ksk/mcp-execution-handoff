FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      gcc \
      libc6-dev \
      libx11-dev \
      libxtst-dev \
      openbox \
      pkg-config \
      x11-utils \
      xdotool \
      xvfb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY native ./native
COPY scripts ./scripts
RUN npm run build \
 && npm run build:linux-xtest-helper \
 && npm prune --omit=dev \
 && test -x dist/native/mcp-handoff-linux-xtest-helper

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/experimental/websocket-cloud-run-acceptance-server.js"]
