FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      gcc \
      libc6-dev \
      libx11-dev \
      libxres-dev \
      libxtst-dev \
      openbox \
      pkg-config \
      x11-utils \
      x11-xserver-utils \
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
COPY experiments/websocket-cloud-run/xrecord-key-delivery-probe.c ./experiments/websocket-cloud-run/xrecord-key-delivery-probe.c
RUN npm run build \
 && npm run build:linux-xtest-helper \
 && mkdir -p dist/native \
 && cc \
      -std=c11 -O2 -Wall -Wextra -Werror -pedantic \
      -D_POSIX_C_SOURCE=200809L -D_FORTIFY_SOURCE=2 -fstack-protector-strong -fPIE \
      experiments/websocket-cloud-run/xrecord-key-delivery-probe.c \
      -Wl,-z,relro,-z,now -pie -lX11 -lXtst -lXRes \
      -o dist/native/mcp-handoff-wss-xrecord-key-probe \
 && chmod 0755 dist/native/mcp-handoff-wss-xrecord-key-probe \
 && npm prune --omit=dev \
 && test -x dist/native/mcp-handoff-linux-xtest-helper \
 && test -x dist/native/mcp-handoff-wss-xrecord-key-probe

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/experimental/websocket-cloud-run-acceptance-server.js"]
