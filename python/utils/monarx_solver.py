"""
utils/monarx_solver.py
Tanggung jawab tunggal: Memecahkan tantangan Proof-of-Work (POW) Monarx WAF (captcha-view) dan mengembalikan header otentikasi.
"""

import base64
import hashlib
import json
import logging
import re

log = logging.getLogger(__name__)


def solve_monarx_challenge(html: str) -> dict | None:
    """
    Ekstrak data challenge dari HTML Monarx, hitung solusi Proof-of-Work (SHA-256),
    dan kembalikan dict header berisi 'x-mnx-challenge'.
    Jika gagal atau bukan captcha-view, kembalikan None.
    """
    m = re.search(r'var\s+rawChallengeData\s*=\s*["\']([^"\']+)["\']', html)
    if not m:
        return None

    raw_data = m.group(1).strip()
    if not raw_data:
        return None

    try:
        challenge_bytes = base64.b64decode(raw_data)
        challenge = json.loads(challenge_bytes.decode("utf-8"))
    except Exception as e:
        log.warning(f"Gagal mendecode rawChallengeData Monarx: {e}")
        return None

    salt = challenge.get("salt", "")
    target_hash = challenge.get("challenge", "")
    max_number = challenge.get("maxnumber", 100000)
    algorithm = challenge.get("algorithm", "SHA-256")
    signature = challenge.get("signature", "")

    if not salt or not target_hash:
        return None

    log.info(f"[Monarx] Menyelesaikan POW challenge (max={max_number})...")
    found_number = None

    for n in range(max_number + 1):
        test_str = f"{salt}{n}".encode("utf-8")
        if hashlib.sha256(test_str).hexdigest() == target_hash:
            found_number = n
            break

    if found_number is None:
        log.warning("[Monarx] Tidak dapat menemukan solusi POW dalam batas max_number.")
        return None

    log.info(f"[Monarx] Solusi POW ditemukan: n={found_number}")

    payload = {
        "algorithm": algorithm,
        "challenge": target_hash,
        "number": found_number,
        "salt": salt,
        "signature": signature,
    }

    payload_json = json.dumps(payload, separators=(",", ":"))
    payload_b64 = base64.b64encode(payload_json.encode("utf-8")).decode("utf-8")

    return {"x-mnx-challenge": payload_b64}
