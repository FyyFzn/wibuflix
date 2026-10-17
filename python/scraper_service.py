"""
scraper_service.py
Tanggung jawab tunggal: HTTP server (Flask) untuk scraper service.
Menerima request HTTP dari Node.js, mengarahkan ke fetcher & parser yang sesuai,
dan mengembalikan respon JSON.

Endpoint:
  POST /scrape/samehadaku/series  { "url": "https://v2.samehadaku.how/anime/..." }
  POST /scrape/samehadaku/latest  { "url": "https://v2.samehadaku.how/" }
  POST /scrape/kuronime/series    { "url": "https://kuronime.sbs/anime/..." }
  POST /scrape/kuronime/latest    { "url": "https://kuronime.sbs/" }
  GET  /health
"""

import os
import sys
import re
import logging
from flask import Flask, request, jsonify

# Pastikan folder python ada di sys.path
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

from fetcher import fetch_html
from parsers.samehadaku import parse_series as parse_samehadaku_series
from parsers.samehadaku import parse_latest as parse_samehadaku_latest
from parsers.kuronime import parse_series as parse_kuronime_series
from parsers.kuronime import parse_latest as parse_kuronime_latest

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="[ScraperService] %(message)s")
log = logging.getLogger(__name__)


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "wibuflix-scraper-py"}), 200


# ── Samehadaku ────────────────────────────────────────────────────────────────

@app.route("/scrape/samehadaku/series", methods=["POST"])
def scrape_samehadaku_series():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
    try:
        html = fetch_html(url)
        result = parse_samehadaku_series(html, url)
        if not result["daftar_episode"]:
            log.warning(f"Tidak ada episode ditemukan untuk: {url}")
        return jsonify(result), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping {url}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/scrape/samehadaku/latest", methods=["POST"])
def scrape_samehadaku_latest():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
    try:
        html = fetch_html(url)
        updates = parse_samehadaku_latest(html)
        return jsonify(updates), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping latest {url}: {e}")
        return jsonify({"error": str(e)}), 500


# ── Kuronime ─────────────────────────────────────────────────────────────────

@app.route("/scrape/kuronime/series", methods=["POST"])
def scrape_kuronime_series():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400

    target_url = url
    if "/anime/" not in url:
        match = re.search(r"/(?:nonton-)?([^/]+?)-episode-\d+", url, re.I)
        if match and match.group(1):
            base_match = re.match(r"^(https?://[^/]+)", url)
            base_url = base_match.group(1) if base_match else "https://kuronime.sbs"
            target_url = f"{base_url}/anime/{match.group(1)}/"
            log.info(f"[Kuronime] Auto-redirect URL episode ke seri: {target_url}")

    try:
        html = fetch_html(target_url)
        result = parse_kuronime_series(html, target_url)
        if not result["daftar_episode"]:
            log.warning(f"Tidak ada episode ditemukan untuk: {target_url}")
        return jsonify(result), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping {target_url}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/scrape/kuronime/latest", methods=["POST"])
def scrape_kuronime_latest():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip() or "https://kuronime.sbs/"
    try:
        html = fetch_html(url)
        updates = parse_kuronime_latest(html)
        return jsonify(updates), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping kuronime latest {url}: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("SCRAPER_PORT", 5001))
    log.info(f"Memulai Wibuflix Scraper Service di port {port}...")
    # threaded=False: satu thread untuk menghindari race condition pada _session curl_cffi
    # use_reloader=False: hindari proses fork yang menduplikasi state _session
    app.run(host="0.0.0.0", port=port, debug=False, threaded=False, use_reloader=False)
