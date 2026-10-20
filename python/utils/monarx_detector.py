"""
utils/monarx_detector.py
Tanggung jawab tunggal: Mendeteksi apakah konten HTML merupakan respons Monarx WAF (captcha-view atau block-view).
"""

MONARX_MARKERS = [
    'id="mx-page"',
    'class="mnx-app"',
    'x-mnx-challenge',
    'support.monarx.com',
]


def is_monarx_challenge(html: str) -> bool:
    """Periksa apakah respons HTML berasal dari Monarx WAF."""
    if not html:
        return False
    return any(marker in html for marker in MONARX_MARKERS)


def is_monarx_captcha(html: str) -> bool:
    """Periksa apakah respons Monarx merupakan challenge interaktif (captcha-view)."""
    return is_monarx_challenge(html) and "captcha-view" in html


def is_monarx_blocked(html: str) -> bool:
    """Periksa apakah respons Monarx merupakan IP block langsung (block-view)."""
    return is_monarx_challenge(html) and ("block-view" in html or "Access Denied" in html)
