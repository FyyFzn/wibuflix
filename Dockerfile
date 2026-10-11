# ── Wibuflix Backend — Docker Image ──────────────────────
# Node.js + Puppeteer (Chromium) + Python scraper service
#
# Build:  docker build -t wibuflix-api .
# Run:    docker run -d -p 3000:3000 --name wibuflix-api wibuflix-api
# ──────────────────────────────────────────────────────────

FROM node:20-slim

# Install Chromium dependencies
# Install Chromium and all required X11/DRI/Mesa/Pango dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcb-dri3-0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxtst6 \
    xdg-utils \
    wget \
    unzip \
    tar \
    bzip2 \
    xz-utils \
    ca-certificates \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Biarkan Puppeteer mendownload & memakai official Chrome for Testing (CfT)
# (Tidak memakai /usr/bin/chromium bawaan Debian yang tidak kompatibel di Azure App Service)

WORKDIR /app

# Install Python dependencies
COPY python/requirements.txt ./python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies (production only)
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY server-prod.js ./
COPY python/ ./python/
COPY start.sh ./
RUN chmod +x start.sh

# Environment variables
ENV PORT=3000
ENV NODE_ENV=production
ENV SCRAPER_PORT=5001

# Expose single port supported by Azure Web App for Containers
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start both Python scraper service and Node.js server
CMD ["./start.sh"]
