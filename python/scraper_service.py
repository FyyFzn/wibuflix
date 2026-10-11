"""
scraper_service.py
Tanggung jawab tunggal: Menerima URL dari Node.js, mengambil HTML menggunakan
curl_cffi (impersonasi TLS Chrome asli untuk melewati Cloudflare Turnstile),
mem-parsing HTML menjadi JSON terstruktur, dan mengembalikannya ke Node.

Endpoint:
  POST /scrape/samehadaku/series  { "url": "https://v2.samehadaku.how/anime/..." }
  POST /scrape/samehadaku/latest  { "url": "https://v2.samehadaku.how/" }
  GET  /health
"""

import os
import re
import logging
from flask import Flask, request, jsonify
from curl_cffi import requests as cf_requests
from bs4 import BeautifulSoup

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="[ScraperService] %(message)s")
log = logging.getLogger(__name__)

# Impersonasi Chrome 124 agar TLS fingerprint cocok dengan browser asli.
# Gunakan Session persisten agar CF cookie dari satu request dibawa ke request berikutnya.
IMPERSONATE = "chrome124"
TIMEOUT = 30
_session = cf_requests.Session(impersonate=IMPERSONATE)

CF_CHALLENGE_MARKERS = [
    "Just a moment",
    "One moment, please",
    "cf-browser-verification",
    "Checking your browser",
    "jschl-answer",
    "cf_chl_opt",
]


def is_cf_challenge(html: str) -> bool:
    # Periksa marker CF challenge — jangan gunakan "turnstile" karena muncul
    # sebagai kunci JS di halaman normal Samehadaku (bukan sebagai CF block page).
    return any(marker in html for marker in CF_CHALLENGE_MARKERS)


def fetch_html(url: str) -> str:
    """Ambil HTML dari URL menggunakan curl_cffi dengan impersonasi Chrome dan session persisten."""
    log.info(f"Fetching: {url}")
    resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True)
    resp.raise_for_status()
    html = resp.text
    if is_cf_challenge(html):
        # Retry sekali — CF mungkin set cookie di response pertama
        log.warning(f"CF challenge terdeteksi, retry sekali untuk {url}")
        resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
        html = resp.text
    if is_cf_challenge(html):
        raise RuntimeError(f"Cloudflare challenge masih aktif untuk {url}")
    return html


def parse_series(html: str, target_url: str) -> dict:
    """
    Parsing halaman seri Samehadaku menjadi JSON terstruktur.
    Mengembalikan: { judul_seri, cover_scraper, daftar_episode: [{judul, url}] }
    """
    soup = BeautifulSoup(html, "html.parser")

    # Judul seri
    raw_title = ""
    title_tag = soup.find("title")
    if title_tag:
        raw_title = title_tag.get_text(strip=True)
    # Bersihkan suffix umum
    for suffix in [" Subtitle Indonesia", " Sub Indo", " - Samehadaku"]:
        raw_title = raw_title.replace(suffix, "").strip()

    # Cover image
    cover_img = ""
    og_image = soup.find("meta", property="og:image")
    if og_image and og_image.get("content"):
        cover_img = og_image["content"]
    else:
        thumb = soup.select_one(".thumb img, .thumbook img")
        if thumb:
            cover_img = thumb.get("src", "")

    # Deteksi season saat ini
    season_match = re.search(r"season\s*(\d+)", raw_title, re.IGNORECASE)
    current_season = int(season_match.group(1)) if season_match else 1
    clean_base_title = re.sub(r"season\s*\d+", "", raw_title, flags=re.IGNORECASE).strip().lower()

    # Kumpulkan episode — Samehadaku v2 pakai Tailwind, episode ada di h4 > a
    seen_urls = set()
    daftar_episode = []

    for a in soup.select("h4 a[href*='episode']"):
        title = a.get_text(strip=True)
        url = a["href"]

        if "batch" in title.lower():
            continue

        # Filter episode dari season berbeda
        ep_season_match = re.search(r"season\s*(\d+)", title, re.IGNORECASE)
        if ep_season_match:
            ep_season = int(ep_season_match.group(1))
            if ep_season != current_season:
                continue

        # Perpendek judul episode
        short_title = title
        title_to_strip = re.sub(r"subtitle\s*indonesia", "", raw_title, flags=re.IGNORECASE).strip()
        if title_to_strip:
            stripped = re.sub(re.escape(title_to_strip), "", title, flags=re.IGNORECASE).strip()
            has_ep_marker = bool(re.search(r"\d|OVA|OAD|Special|SP|Movie|Film", stripped, re.IGNORECASE))
            if stripped and len(stripped) >= 2 and has_ep_marker:
                short_title = stripped

        if not short_title or len(short_title) < 2:
            short_title = title
        short_title = short_title[0].upper() + short_title[1:]

        if url not in seen_urls:
            seen_urls.add(url)
            daftar_episode.append({"judul": short_title, "url": url})

    # Fallback: Movie/Spesial tanpa daftar episode
    if not daftar_episode:
        download_link = soup.select_one(".download-eps a, .dl-box a, .soraddlx a")
        iframe = soup.select_one(".player-area iframe, #player iframe, .pd-expand iframe")
        if download_link or iframe:
            daftar_episode.append({
                "judul": raw_title or "Full Movie / Episode Spesial",
                "url": target_url,
            })

    return {
        "judul_seri": raw_title,
        "cover_scraper": cover_img,
        "daftar_episode": daftar_episode,
    }


def parse_latest(html: str) -> list:
    """
    Parsing halaman utama Samehadaku untuk update terbaru.
    Mengembalikan: [{judul, status}]
    """
    soup = BeautifulSoup(html, "html.parser")
    updates = []
    for el in soup.select(".post-show ul li, .animepost"):
        title_node = el.select_one(".entry-title a, .title a, .entry-title, .title, .tt h2")
        if not title_node:
            continue
        judul = title_node.get_text(strip=True)
        status = None
        for sp in el.select(".dtla span, span"):
            txt = sp.get_text(" ", strip=True)
            m = re.search(r"Episode\s*(\d+)", txt, re.I)
            if m:
                status = f"Eps {m.group(1)}"
                break
        if not status:
            ep_node = el.select_one('author[itemprop="name"], .epx')
            if ep_node:
                eps_text = ep_node.get_text(strip=True)
                status = eps_text if "eps" in eps_text.lower() else f"Eps {eps_text}"
        if judul and status:
            updates.append({"judul": judul, "status": status})
    return updates


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "wibuflix-scraper-py"}), 200


@app.route("/scrape/samehadaku/series", methods=["POST"])
def scrape_series():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
    try:
        html = fetch_html(url)
        result = parse_series(html, url)
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
def scrape_latest():
    body = request.get_json(silent=True) or {}
    url = body.get("url", "").strip()
    if not url:
        return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
    try:
        html = fetch_html(url)
        updates = parse_latest(html)
        return jsonify(updates), 200
    except RuntimeError as e:
        log.error(str(e))
        return jsonify({"error": str(e)}), 502
    except Exception as e:
        log.error(f"Error scraping latest {url}: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("SCRAPER_PORT", 5001))
    log.info(f"Memulai Wibuflix Scraper Service di port {port}...")
    # threaded=False: satu thread untuk menghindari race condition pada _session curl_cffi
    # use_reloader=False: hindari proses fork yang menduplikasi state _session
    app.run(host="0.0.0.0", port=port, debug=False, threaded=False, use_reloader=False)
