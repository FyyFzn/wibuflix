"""
parsers/samehadaku.py
Tanggung jawab tunggal: Mem-parsing halaman HTML Samehadaku (series dan latest updates) menjadi struktur data dictionary.
"""

import re
from bs4 import BeautifulSoup


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
