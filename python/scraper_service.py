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
import time
from flask import Flask, request, jsonify
import cloudscraper

# Pastikan folder python ada di sys.path
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

from fetcher import fetch_html, _session, _session_lock, _force_reset_session
from parsers.samehadaku import parse_series as parse_samehadaku_series
from parsers.samehadaku import parse_latest as parse_samehadaku_latest
from parsers.kuronime import parse_series as parse_kuronime_series
from parsers.kuronime import parse_latest as parse_kuronime_latest
from parsers.oploverz import parse_series as parse_oploverz_series
from parsers.oploverz import parse_latest as parse_oploverz_latest
from parsers.nimegami import parse_series as parse_nimegami_series
from parsers.nimegami import parse_latest as parse_nimegami_latest
from parsers.ylnime import parse_series as parse_ylnime_series
from parsers.ylnime import parse_latest as parse_ylnime_latest

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


@app.route("/scrape/kuronime/decrypt", methods=["POST"])
def scrape_kuronime_decrypt():
    body = request.get_json(silent=True) or {}
    token = body.get("token", "").strip()
    request_id = body.get("requestId", "unknown")
    
    if not token:
        return jsonify({"error": "Parameter 'token' wajib diisi"}), 400

    log.info(f"[Kuronime] [{request_id}] Decrypt request received, token={token[:20]}...")

    try:
        with _session_lock:
            resp = _session.post(
                "https://animeku.org/api/v9/sources",
                json={"id": token},
                headers={
                    "Content-Type": "application/json",
                    "Referer": "https://kuronime.sbs/",
                    "Origin": "https://kuronime.sbs",
                },
                timeout=15,
            )
        
        log.info(f"[Kuronime] [{request_id}] First attempt: animeku.org returned {resp.status_code}")
        
        # Retry dengan session baru jika 403 (cold session setelah restart)
        if resp.status_code == 403:
            log.warning(f"[Kuronime] [{request_id}] 403 dari animeku.org, reset session dan retry setelah 2s...")
            _force_reset_session()
            time.sleep(2)
            with _session_lock:
                resp = _session.post(
                    "https://animeku.org/api/v9/sources",
                    json={"id": token},
                    headers={
                        "Content-Type": "application/json",
                        "Referer": "https://kuronime.sbs/",
                        "Origin": "https://kuronime.sbs",
                    },
                    timeout=15,
                )
            log.info(f"[Kuronime] [{request_id}] Retry attempt: animeku.org returned {resp.status_code}")
        
        if resp.status_code != 200:
            log.error(f"[Kuronime] [{request_id}] Animeku returned status {resp.status_code}: {resp.text[:200]}")
            try:
                return jsonify(resp.json()), resp.status_code
            except Exception:
                return jsonify({"error": f"Animeku returned status {resp.status_code}"}), 502

        log.info(f"[Kuronime] [{request_id}] Success: returning decrypted sources")
        return jsonify(resp.json()), 200
    except Exception as e:
        log.error(f"[Kuronime] [{request_id}] Gagal menghubungi animeku.org: {e}")
        return jsonify({"error": str(e)}), 502


# ── Oploverz ─────────────────────────────────────────────────────────────────

@app.route("/scrape/oploverz/series", methods=["POST"])
def scrape_oploverz_series():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
    try:
        html = fetch_html(url)
        result = parse_oploverz_series(html, url)
        if not result["daftar_episode"]:
            log.warning(f"Tidak ada episode ditemukan untuk: {url}")
        return jsonify(result), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping oploverz {url}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/scrape/oploverz/latest", methods=["POST"])
def scrape_oploverz_latest():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip() or "https://oploverz.site/schedule"
    try:
        html = fetch_html(url)
        updates = parse_oploverz_latest(html)
        return jsonify(updates), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping oploverz schedule {url}: {e}")
        return jsonify({"error": str(e)}), 500


# ── Nimegami ─────────────────────────────────────────────────────────────────

@app.route("/scrape/nimegami/series", methods=["POST"])
def scrape_nimegami_series():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
    try:
        html = fetch_html(url)
        result = parse_nimegami_series(html, url)
        if not result["daftar_episode"]:
            log.warning(f"Tidak ada episode ditemukan untuk: {url}")
        return jsonify(result), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping nimegami {url}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/scrape/nimegami/latest", methods=["POST"])
def scrape_nimegami_latest():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip() or "https://nimegami.id/"
    try:
        html = fetch_html(url)
        updates = parse_nimegami_latest(html)
        return jsonify(updates), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping nimegami latest {url}: {e}")
        return jsonify({"error": str(e)}), 500


# ── YLnime ───────────────────────────────────────────────────────────────────

@app.route("/scrape/ylnime/series", methods=["POST"])
def scrape_ylnime_series():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
    try:
        html = fetch_html(url)
        result = parse_ylnime_series(html, url)
        if not result["daftar_episode"]:
            log.warning(f"Tidak ada episode ditemukan untuk: {url}")
        return jsonify(result), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping ylnime {url}: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/scrape/ylnime/latest", methods=["POST"])
def scrape_ylnime_latest():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip() or "https://ylnime.com/index.php?terbaru=1"
    try:
        html = fetch_html(url)
        updates = parse_ylnime_latest(html)
        return jsonify(updates), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping ylnime latest {url}: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("SCRAPER_PORT", 5001))
    log.info(f"Memulai Wibuflix Scraper Service di port {port}...")
    # threaded=False: satu thread untuk menghindari race condition pada _session curl_cffi
    # use_reloader=False: hindari proses fork yang menduplikasi state _session
    app.run(host="0.0.0.0", port=port, debug=False, threaded=False, use_reloader=False)
