"""
parsers/oploverz.py
Tanggung jawab tunggal: Mem-parsing halaman HTML Oploverz (series dan schedule/updates) menjadi struktur data dictionary.
"""

import re
from bs4 import BeautifulSoup


def parse_series(html: str, target_url: str) -> dict:
    """
    Parsing halaman seri Oploverz menjadi JSON terstruktur.
    Mengembalikan: { judul_seri, cover_scraper, daftar_episode: [{judul, url}] }
    """
    soup = BeautifulSoup(html, "html.parser")

    raw_title = ""
    h1 = soup.find("h1")
    if h1:
        raw_title = h1.get_text(strip=True)
    elif soup.title:
        raw_title = re.sub(r"Oploverz|subtitle indonesia", "", soup.title.get_text(strip=True), flags=re.I).strip()

    # Bersihkan suffix umum
    for suffix in [" Subtitle Indonesia", " Sub Indo", " |"]:
        raw_title = raw_title.replace(suffix, "").strip()

    cover_img = ""
    og_img = soup.find("meta", property="og:image")
    if og_img and og_img.get("content"):
        cover_img = og_img["content"]
    elif soup.find("img"):
        first_img = soup.find("img")
        if first_img:
            cover_img = first_img.get("src", "")

    episodes = []
    seen_nums = set()

    for a in soup.find_all("a", href=re.compile(r"^/series/.*(?:/episode/|\-episode\-)")):
        href = a.get("href", "")
        title_raw = a.get_text(strip=True) or a.get("title", "") or "Episode"
        if "batch" in title_raw.lower():
            continue

        full_url = f"https://oploverz.site{href}" if href.startswith("/") else href

        # Cek apakah episode merupakan rentang/gabungan ganda (cth: Episode 166-167)
        range_match = re.search(r"/episode/(\d+)-(\d+)/?", href, re.I) or re.search(
            r"(?:episode|ep|eps)\s*(\d+)\s*[-–]\s*(\d+)", title_raw, re.I
        )
        if range_match:
            start_n = int(range_match.group(1))
            end_n = int(range_match.group(2))
            if start_n <= end_n and (end_n - start_n) <= 15:
                for n in range(start_n, end_n + 1):
                    if n not in seen_nums:
                        seen_nums.add(n)
                        episodes.append({"judul": f"Episode {n}", "url": full_url, "num": n})
                continue

        num_match = re.search(r"/episode/(\d+(?:\.\d+)?)", href, re.I)
        num = float(num_match.group(1)) if num_match else None
        if num is None:
            tm = re.search(r"(?:episode|ep|eps)\s*(\d+(?:\.\d+)?)", title_raw, re.I)
            num = float(tm.group(1)) if tm else None

        if num is not None and num not in seen_nums:
            seen_nums.add(num)
            ep_title = f"Episode {int(num) if num.is_integer() else num}"
            episodes.append({"judul": ep_title, "url": full_url, "num": num})

    episodes.sort(key=lambda x: x["num"])
    clean_episodes = [{"judul": e["judul"], "url": e["url"]} for e in episodes]

    return {
        "judul_seri": raw_title,
        "cover_scraper": cover_img,
        "daftar_episode": clean_episodes,
    }


def parse_latest(html: str) -> list:
    """
    Parsing halaman jadwal rilis Oploverz (/schedule) untuk update terbaru.
    Mengembalikan: [{judul, status, url}]
    """
    soup = BeautifulSoup(html, "html.parser")
    updates = []
    seen = set()

    for a in soup.find_all("a", href=re.compile(r"/series/")):
        href = a.get("href", "")
        if not re.search(r"^/series/[a-z0-9-]+/?$", href, re.I):
            continue

        raw_text = " ".join(a.get_text().split()).strip()
        if not raw_text or raw_text.lower() in seen:
            continue
        seen.add(raw_text.lower())

        time_m = re.match(r"^(\d{1,2}[:.]\d{2})\s*(?:WIB|WITA|WIT)?\s*(.*)$", raw_text, re.I)
        time_str = ""
        title = raw_text
        if time_m:
            time_str = time_m.group(1)
            title = time_m.group(2).strip()

        if title:
            full_series_url = f"https://oploverz.site{href}" if href.startswith("/") else href
            updates.append({
                "judul": title,
                "status": f"Eps {time_str}" if time_str else "Eps",
                "url": full_series_url,
            })

    return updates
