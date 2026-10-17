"""
fetcher.py
Tanggung jawab tunggal: Mengambil konten HTML dari URL menggunakan curl_cffi
dengan impersonasi TLS Chrome dan penanganan tantangan Cloudflare.
"""

import os
import sys
import logging
import threading
import time
from curl_cffi import requests as cf_requests

# Pastikan folder python ada di sys.path
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if _BASE_DIR not in sys.path:
    sys.path.insert(0, _BASE_DIR)

from utils.cf_detector import is_cf_challenge

log = logging.getLogger(__name__)

IMPERSONATE = "chrome124"
TIMEOUT = 30
_session = cf_requests.Session(impersonate=IMPERSONATE)
_session_lock = threading.Lock()
_SESSION_TTL = 2 * 60 * 60  # 2 hours


def _reset_session():
    global _session
    while True:
        time.sleep(_SESSION_TTL)
        with _session_lock:
            _session = cf_requests.Session(impersonate=IMPERSONATE)
        log.info("curl_cffi session direset (TTL habis).")


_reset_thread = threading.Thread(target=_reset_session, daemon=True)
_reset_thread.start()


def fetch_html(url: str) -> str:
    """Ambil HTML dari URL menggunakan curl_cffi dengan impersonasi Chrome dan session persisten."""
    log.info(f"Fetching: {url}")
    with _session_lock:
        resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True)
    resp.raise_for_status()
    html = resp.text
    if is_cf_challenge(html):
        log.warning(f"CF challenge terdeteksi, retry sekali untuk {url}")
        with _session_lock:
            resp = _session.get(url, timeout=TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
        html = resp.text
    if is_cf_challenge(html):
        raise RuntimeError(f"Cloudflare challenge masih aktif untuk {url}")
    return html
