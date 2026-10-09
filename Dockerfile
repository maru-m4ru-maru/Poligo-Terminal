FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    bubblewrap \
    build-essential \
    ca-certificates \
    curl \
    git \
    procps \
    python3 \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./package.json
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

ENV NODE_ENV=production
ENV PORT=10000

CMD ["node", "src/server.js"]
