FROM node:22-bookworm-slim

# Instala o necessário, incluindo o xvfb para simular interface gráfica
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    libnss3 \
    libatk-bridge2.0-0 \
    libcups2 \
    libxkbcommon0 \
    libgtk-3-0 \
    libasound2t64 \
    libgbm1 \
    libxshmfence1 \
    libnspr4 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Comando de start usando o xvfb igual ao projeto que funciona
CMD ["xvfb-run", "--server-args=-screen 0 1280x720x24", "node", "server.js"]