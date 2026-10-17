"""
parsers/nimegami.py
Tanggung jawab tunggal: Mem-parsing halaman HTML Nimegami (series dan latest updates) menjadi struktur data dictionary.
"""

import re
from bs4 import BeautifulSoup


def parse_series(html: str, target_url: str) -> dict:
    """
    Parsing halaman seri Nimegami menjadi JSON terstruktur.
    Mendukung format Next.js terbaru (a[href^="#episode_"]) dan legacy WordPress (li.select-eps).
    Mengembalikan: { judul_seri, cover_scraper, daftar_episode: [{judul, url}] }
    """
    soup = BeautifulSoup(html, "html.parser")

    raw_title = ""
    h1 = soup.find("h1")
    if h1:
        raw_title = h1.get_text(strip=True)
    elif soup.title:
        raw_title = soup.title.get_text(strip=True)

    for suffix in ["- Nimegami", "Sub Indo", "Subtitle Indonesia", "| Nimegami", "BD Sub"]:
        raw_title = re.sub(re.escape(suffix), "", raw_title, flags=re.I).strip()
    raw_title = re.sub(r":\s*Episode\s*\d+.*$", "", raw_title, flags=re.I).strip()

    cover_img = ""
    og_img = soup.find("meta", property="og:image")
    if og_img and og_img.get("content"):
        cover_img = og_img["content"]
    else:
        thumb = soup.select_one(".coverthumbnail img, .thumbnail img, img")
        if thumb and thumb.get("src"):
            cover_img = thumb.get("src", "")

    episodes = []
    seen_nums = set()
    clean_base_url = target_url.split("?")[0].rstrip("/")

    # 1. Format Next.js baru: a[href^="#episode_"]
    for a in soup.select("a[href^='#episode_']"):
        href = a.get("href", "")
        m = re.search(r"#episode_(\d+)", href)
        if m:
            ep_num = int(m.group(1))
            if ep_num not in seen_nums:
                seen_nums.add(ep_num)
                title = a.get("title") or a.get("aria-label") or f"Episode {ep_num}"
                virtual_url = f"{clean_base_url}?ep={ep_num}"
                episodes.append({"judul": title, "url": virtual_url, "num": ep_num})

    # 2. Format legacy WordPress: li.select-eps
    if not episodes:
        for el in soup.select("div.list_eps_stream li.select-eps, .streaming_eps_box li.select-eps"):
            ep_text = el.get_text(strip=True)
            ep_id = el.get("id", "")
            id_m = re.search(r"play_eps_(\d+)", ep_id, re.I)
            ep_num = int(id_m.group(1)) if id_m else None
            if ep_num is None:
                tm = re.search(r"(?:episode|ep)\s*(\d+)", ep_text, re.I)
                ep_num = int(tm.group(1)) if tm else None

            if ep_num is not None and ep_num not in seen_nums:
                seen_nums.add(ep_num)
                virtual_url = f"{clean_base_url}?ep={ep_num}"
                episodes.append({"judul": ep_text or f"Episode {ep_num}", "url": virtual_url, "num": ep_num})

    episodes.sort(key=lambda x: x["num"])
    clean_episodes = [{"judul": e["judul"], "url": e["url"]} for e in episodes]

    return {
        "judul_seri": raw_title,
        "cover_scraper": cover_img,
        "daftar_episode": clean_episodes,
    }


def parse_latest(html: str) -> list:
    """
    Parsing halaman utama Nimegami untuk anime rilis/update terbaru.
    Mengembalikan: [{judul, status, url}]
    """
    soup = BeautifulSoup(html, "html.parser")
    updates = []
    seen = set()

    for card in soup.select("article.anime-card"):
        links = [a for a in card.find_all("a") if a.get("href") and "-sub-indo" in a.get("href")]
        if not links:
            continue
        last_link = links[-1]
        href = last_link.get("href", "")
        full_url = f"https://nimegami.id{href}" if href.startswith("/") else href
        title = last_link.get_text(strip=True)
        if not title or full_url in seen:
            continue
        seen.add(full_url)

        status = "ONGOING"
        card_text = card.get_text(" ", strip=True)
        m = re.search(r"(\d+)\s*episode", card_text, re.I)
        if m:
            status = f"Eps {m.group(1)}"

        updates.append({"judul": title, "status": status, "url": full_url})

    return updates
