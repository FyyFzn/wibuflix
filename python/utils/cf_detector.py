"""
utils/cf_detector.py
Tanggung jawab tunggal: Mendeteksi apakah konten HTML merupakan halaman tantangan Cloudflare.
"""

CF_CHALLENGE_MARKERS = [
    "Just a moment",
    "One moment, please",
    "cf-browser-verification",
    "Checking your browser",
    "jschl-answer",
    "cf_chl_opt",
]


def is_cf_challenge(html: str) -> bool:
    """
    Periksa marker CF challenge — jangan gunakan 'turnstile' karena muncul
    sebagai kunci JS di halaman normal Samehadaku.
    """
    if not html:
        return False
    return any(marker in html for marker in CF_CHALLENGE_MARKERS)
