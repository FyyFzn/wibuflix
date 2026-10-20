"""
fetcher.py
Tanggung jawab tunggal: Mengambil konten HTML dari URL menggunakan curl_cffi
dengan impersonasi TLS Chrome dan penanganan tantangan Cloudflare & Monarx WAF.
"""

import os
import sys
import logging
import threading
import time
from curl_cffi import requests as cf_requests
import cloudscraper

# Pastikan folder python ada di sys.path
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

from utils.cf_detector import is_cf_challenge
from utils.monarx_detector import is_monarx_challenge, is_monarx_captcha, is_monarx_blocked
from utils.monarx_solver import solve_monarx_challenge

log = logging.getLogger(__name__)

IMPERSONATE = "chrome124"
TIMEOUT = 30
_session = cf_requests.Session(impersonate=IMPERSONATE)
_session_lock = threading.Lock()
_SESSION_TTL = 2 * 60 * 60  # 2 hours

# Proxy dari env (sama dengan PROXY_URL di Node scrapeHelper.js)
_PROXY_URL = os.environ.get("PROXY_URL", "").strip() or None
_proxies = {"https": _PROXY_URL, "http": _PROXY_URL} if _PROXY_URL else None

# Cloudscraper instance (bypasses Cloudflare better than curl_cffi for certain sites)
cloudscraper_session = cloudscraper.create_scraper(
    browser={'browser': 'chrome', 'platform': 'windows', 'desktop': True}
)

# Domain whitelist that requires cloudscraper instead of curl_cffi
CLOUDSCRAPER_DOMAINS = ['samehadaku', 'animeku']

_last_ylnime_fetch_time = 0.0


def _reset_session():
    global _session
    while True:
        time.sleep(_SESSION_TTL)
        with _session_lock:
            _session = cf_requests.Session(impersonate=IMPERSONATE)
        log.info("curl_cffi session direset (TTL habis).")


_reset_thread = threading.Thread(target=_reset_session, daemon=True)
_reset_thread.start()


def _force_reset_session():
    """Reset session di tempat — membuat TLS fingerprint dan cookie jar baru."""
    global _session
    with _session_lock:
        _session = cf_requests.Session(impersonate=IMPERSONATE)
    log.info("curl_cffi session di-reset paksa (retry setelah 403/CF/Monarx).")


def _warmup_ylnime_session(proxies=None):
    """Pastikan session memiliki cookie dasar (PHPSESSID) sebelum request halaman seri/episode."""
    try:
        log.info("[YLnime] Warming up session di homepage...")
        _session.get("https://ylnime.com/", timeout=15, proxies=proxies)
    except Exception as e:
        log.warning(f"[YLnime] Session warmup gagal (diabaikan): {e}")


def fetch_html(url: str) -> str:
    """Ambil HTML dari URL. Gunakan cloudscraper untuk domain yang di-whitelist (Cloudflare agresif),
    gunakan curl_cffi untuk domain lainnya (lebih cepat).
    Domain tertentu (ylnime, kuronime) langsung menggunakan proxy jika tersedia."""
    global _last_ylnime_fetch_time
    log.info(f"Fetching: {url}")
    
    url_lower = url.lower()
    
    # Check if domain requires cloudscraper (aggressive Cloudflare)
    use_cloudscraper = any(domain in url_lower for domain in CLOUDSCRAPER_DOMAINS)
    
    if use_cloudscraper:
        log.info(f"Using cloudscraper for {url}")
        resp = cloudscraper_session.get(url, timeout=TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
        return resp.text
    
    # Default: curl_cffi with proxy logic
    use_proxy = _proxies and any(domain in url_lower for domain in ['ylnime', 'kuronime'])
    target_proxies = _proxies if use_proxy else None

    # Polite pacing & session warm-up untuk YLnime untuk mencegah Monarx WAF rate limit
    if "ylnime" in url_lower:
        now = time.time()
        elapsed = now - _last_ylnime_fetch_time
        if elapsed < 1.5:
            time.sleep(1.5 - elapsed)
        _last_ylnime_fetch_time = time.time()

        with _session_lock:
            cookies = _session.cookies.get_dict() if hasattr(_session.cookies, "get_dict") else {}
            if "PHPSESSID" not in cookies and url.rstrip("/") != "https://ylnime.com":
                _warmup_ylnime_session(proxies=target_proxies)

    headers = {
        "Referer": "https://ylnime.com/" if "ylnime" in url_lower else None,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
    }
    headers = {k: v for k, v in headers.items() if v is not None}

    with _session_lock:
        resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True, 
                           proxies=target_proxies, headers=headers)

    # Tangani respons Monarx WAF jika terdeteksi (meskipun status 200 atau 403)
    if is_monarx_challenge(resp.text):
        if is_monarx_captcha(resp.text):
            log.info(f"[Monarx] Captcha challenge terdeteksi untuk {url}, mencoba menyelesaikan POW...")
            mnx_headers = solve_monarx_challenge(resp.text)
            if mnx_headers:
                headers.update(mnx_headers)
                with _session_lock:
                    resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True,
                                       proxies=target_proxies, headers=headers)
        elif is_monarx_blocked(resp.text):
            log.warning(f"[Monarx] IP diblokir (block-view) oleh Monarx WAF untuk {url}")
            if _proxies and not target_proxies:
                log.info(f"[Monarx] Mencoba ulang via proxy...")
                with _session_lock:
                    resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True,
                                       proxies=_proxies, headers=headers)

    # Retry via proxy jika 403 dan proxy tersedia
    if resp.status_code == 403 and _proxies and not target_proxies:
        log.warning(f"403 dari {url}, retry via proxy...")
        with _session_lock:
            resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True, proxies=_proxies, headers=headers)

    # Retry dengan session baru jika 403 tanpa proxy
    if resp.status_code == 403 and not _proxies:
        if is_monarx_blocked(resp.text):
            raise RuntimeError(f"Monarx WAF IP block aktif untuk {url} (Access Denied)")
        log.warning(f"403 dari {url}, reset session dan retry setelah 2s...")
        _force_reset_session()
        time.sleep(2)
        with _session_lock:
            resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True, headers=headers)

    resp.raise_for_status()
    html = resp.text

    if is_cf_challenge(html):
        log.warning(f"CF challenge terdeteksi, reset session dan retry untuk {url}")
        _force_reset_session()
        time.sleep(2)
        with _session_lock:
            resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True,
                                proxies=target_proxies, headers=headers)
        resp.raise_for_status()
        html = resp.text

    if is_cf_challenge(html):
        raise RuntimeError(f"Cloudflare challenge masih aktif untuk {url}")

    if is_monarx_blocked(html):
        raise RuntimeError(f"Monarx WAF IP block masih aktif untuk {url}")

    return html
