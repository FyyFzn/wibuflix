# ── Wibuflix Backend — Docker Image ──────────────────────
# Node.js + Python scraper service
#
# Build:  docker build -t wibuflix-api .
# Run:    docker run -d -p 3000:3000 --name wibuflix-api wibuflix-api
# ──────────────────────────────────────────────────────────

FROM node:20-slim

# Install system dependencies (Python, CA certificates, decompression utilities)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    wget \
    unzip \
    tar \
    bzip2 \
    xz-utils \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

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
