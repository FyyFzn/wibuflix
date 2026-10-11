#!/bin/bash
# start.sh — Menjalankan Python scraper service dan Node.js server secara bersamaan.
# Python service harus siap sebelum Node mulai menerima scrape request,
# tapi tidak perlu menunggu karena Node punya retry logic di scrapeHelper.

set -e

echo "[start.sh] Memulai Python scraper service (port 5001)..."
python3 /app/python/scraper_service.py &
PYTHON_PID=$!

echo "[start.sh] Memulai Node.js server..."
node server-prod.js &
NODE_PID=$!

trap 'kill $PYTHON_PID $NODE_PID 2>/dev/null' SIGTERM SIGINT

# Jika salah satu proses mati, container ikut mati agar Azure restart otomatis
set +e
wait -n $PYTHON_PID $NODE_PID
EXIT_CODE=$?
echo "[start.sh] Salah satu proses keluar dengan kode $EXIT_CODE. Container berhenti."
kill $PYTHON_PID $NODE_PID 2>/dev/null || true
exit $EXIT_CODE
