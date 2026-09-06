FROM node:20-slim

# ffmpeg de Debian: trae libx264 + libzimg (zscale/tonemap para HDR->SDR).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Deps primero para cachear la capa.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8787

# Un proceso supervisor -> worker + api.
CMD ["npm", "run", "start"]
