# ── FYYStream Backend — Docker Image ──────────────────────
# Node.js + Puppeteer (Chromium) for scraping
#
# Build:  docker build -t fyystream-api .
# Run:    docker run -d -p 3000:3000 --name fyystream-api fyystream-api
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
    && rm -rf /var/lib/apt/lists/*

# Biarkan Puppeteer mendownload & memakai official Chrome for Testing (CfT)
# (Tidak memakai /usr/bin/chromium bawaan Debian yang tidak kompatibel di Azure App Service)

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies (production only)
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY server-prod.js ./


# Expose port
EXPOSE 3000 80 8080 5000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || wget --no-verbose --tries=1 --spider http://localhost:80/ || wget --no-verbose --tries=1 --spider http://localhost:8080/ || wget --no-verbose --tries=1 --spider http://localhost:5000/ || exit 1

# Start server directly via Node.js
CMD ["node", "server-prod.js"]
