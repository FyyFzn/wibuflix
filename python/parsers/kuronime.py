"""
parsers/kuronime.py
Tanggung jawab tunggal: Mem-parsing halaman HTML Kuronime (series dan latest updates) menjadi struktur data dictionary.
"""

import re
from bs4 import BeautifulSoup


def parse_series(html: str, target_url: str) -> dict:
    """
    Parsing halaman seri Kuronime menjadi JSON terstruktur.
    Mengembalikan: { judul_seri, cover_scraper, daftar_episode: [{judul, url}] }
    """
    soup = BeautifulSoup(html, "html.parser")

    # Judul seri
    raw_title = ""
    title_tag = soup.select_one("h1.entry-title, h1[itemprop='name'], title")
    if title_tag:
        raw_title = title_tag.get_text(strip=True)
    for suffix in [" Subtitle Indonesia", " Sub Indo", " - Kuronime"]:
        raw_title = raw_title.replace(suffix, "").strip()

    # Cover image
    cover_img = ""
    og_image = soup.find("meta", property="og:image")
    if og_image and og_image.get("content"):
        cover_img = og_image["content"]
    else:
        thumb = soup.select_one("img[itemprop='image'], .thumb img")
        if thumb:
            cover_img = thumb.get("src", "")

    # Daftar episode
    seen_urls = set()
    daftar_episode = []
    selector = (
        "div.bixbox.bxcl ul li, .eplister ul li, ul.eplister li, .lstepsiode ul li, "
        "#episode_list li, .episodelist ul li, .listeps ul li, .lastep li, "
        "div.bxcl ul li, div.epcurlast ul li, div.bixbox ul li, div.bxcl li"
    )

    for el in soup.select(selector):
        a = el.find("a")
        if not a or not a.get("href"):
            continue
        href = a["href"].strip()
        if href in seen_urls or "/anime/" in href:
            continue

        title_node = el.select_one(".lchx, .epl-num")
        ep_title = title_node.get_text(strip=True) if title_node else a.get_text(strip=True)
        if ep_title:
            seen_urls.add(href)
            daftar_episode.append({"judul": ep_title, "url": href})

    # Kuronime menampilkan episode dari terbaru ke terlama, balikkan agar ascending
    daftar_episode.reverse()

    return {
        "judul_seri": raw_title,
        "cover_scraper": cover_img,
        "daftar_episode": daftar_episode,
    }


def parse_latest(html: str) -> list:
    """
    Parsing halaman utama Kuronime untuk update episode terbaru.
    Mengembalikan: [{judul, status, url}]
    """
    soup = BeautifulSoup(html, "html.parser")
    updates = []
    seen_urls = set()

    first_box = soup.select_one(".bixbox")
    if not first_box:
        return updates

    for el in first_box.select("article.bsu"):
        t_el = el.select_one(".bsuxtt h2")
        ep_el = el.select_one(".bt .ep")
        a = el.select_one("a")
        if not (t_el and ep_el and a and a.get("href")):
            continue

        title = t_el.get_text(strip=True)
        ep = ep_el.get_text(strip=True)
        href = a["href"].strip()

        # Transformasi URL episode ke URL series anime
        # contoh: https://kuronime.sbs/nonton-naruto-episode-1/ -> https://kuronime.sbs/anime/naruto/
        # atau: https://kuronime.sbs/naruto-episode-1-subtitle-indonesia/ -> https://kuronime.sbs/anime/naruto/
        series_url = href
        match = re.search(r"/(?:nonton-)?([^/]+?)-episode-\d+", href, re.I)
        if match and match.group(1):
            base_match = re.match(r"^(https?://[^/]+)", href)
            base_url = base_match.group(1) if base_match else "https://kuronime.sbs"
            series_url = f"{base_url}/anime/{match.group(1)}/"

        if series_url not in seen_urls:
            seen_urls.add(series_url)
            updates.append({"judul": title, "status": ep, "url": series_url})

    return updates
