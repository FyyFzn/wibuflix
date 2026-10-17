"""
parsers/ylnime.py
Tanggung jawab tunggal: Mem-parsing halaman HTML YLnime (series dan latest updates) menjadi struktur data dictionary.
"""

import re
from bs4 import BeautifulSoup


def parse_series(html: str, target_url: str) -> dict:
    """
    Parsing halaman seri YLnime menjadi JSON terstruktur.
    Format URL episode DIJAMIN menggunakan &ep=N (bukan &episode= yang rusak).
    Mengembalikan: { judul_seri, cover_scraper, daftar_episode: [{judul, url}] }
    """
    soup = BeautifulSoup(html, "html.parser")

    # Ambil judul seri
    raw_title = soup.select_one("h1.anime-title, h2.series-title, .series-header h1, h1")
    if raw_title:
        judul_seri = raw_title.get_text(strip=True)
    elif soup.title:
        judul_seri = re.sub(r"[-|].*$", "", soup.title.get_text(strip=True)).strip()
    else:
        judul_seri = "YLnime Series"

    # Cover image
    cover_img = ""
    og_img = soup.find("meta", property="og:image")
    if og_img and og_img.get("content"):
        cover_img = og_img["content"]
    else:
        thumb = soup.select_one(".anime-cover img, .poster img, .series-poster img, img")
        if thumb and thumb.get("src"):
            cover_img = thumb.get("src", "")

    # Ambil slug dari target_url
    m_slug = re.search(r"[?&]series=([^&]+)", target_url)
    slug = m_slug.group(1) if m_slug else ""

    episodes = []
    seen_nums = set()
    selector = (
        "a.list-group-item, .episode-list a, .daftar-eps a, "
        "a[href*='&ep='], a[href*='?ep='], a[href*='episode=']"
    )

    for a in soup.select(selector):
        href = a.get("href", "")
        raw_text = a.get_text(" ", strip=True)
        m = re.search(r"(?:episode|ep)\s*(\d+(?:\.\d+)?)", raw_text, re.I) or re.search(
            r"[?&](?:ep|episode)=(\d+(?:\.\d+)?)", href, re.I
        )
        if not m:
            m = re.search(r"al-\d+-(\d+)", href, re.I)

        if m:
            num_str = m.group(1)
            num = int(num_str) if num_str.isdigit() else float(num_str)
            if num not in seen_nums:
                seen_nums.add(num)
                # Invariant: Gunakan &ep=N secara eksplisit untuk mencegah URL malformed &episode=
                if slug:
                    ep_url = f"https://ylnime.com/index.php?series={slug}&ep={num}"
                else:
                    ep_url = href if href.startswith("http") else f"https://ylnime.com/{href.lstrip('/')}"
                episodes.append({"judul": f"Episode {num}", "url": ep_url, "num": num})

    # Fallback jika tidak ada list item: cek total episode dari teks halaman
    if not episodes and slug:
        body_text = soup.get_text()
        total_m = re.search(r"(\d+)\s*[Ee]pisode", body_text)
        total_eps = int(total_m.group(1)) if total_m else 0
        if total_eps > 0:
            for i in range(1, total_eps + 1):
                ep_url = f"https://ylnime.com/index.php?series={slug}&ep={i}"
                episodes.append({"judul": f"Episode {i}", "url": ep_url, "num": i})

    episodes.sort(key=lambda x: x["num"])
    clean_episodes = [{"judul": e["judul"], "url": e["url"]} for e in episodes]

    return {
        "judul_seri": judul_seri,
        "cover_scraper": cover_img,
        "daftar_episode": clean_episodes,
    }


def parse_latest(html: str) -> list:
    """
    Parsing halaman update terbaru YLnime (index.php?terbaru=1).
    Mengembalikan: [{judul, status, url}]
    """
    soup = BeautifulSoup(html, "html.parser")
    updates = []
    seen = set()

    for el in soup.select(".card"):
        a = el.select_one("a.stretched-link, a[href*='series=']")
        if not a or not a.get("href") or "series=" not in a["href"]:
            continue
        t_el = el.select_one(".card-title, h6")
        if not t_el:
            continue

        title = t_el.get_text(strip=True)
        href = a["href"]
        full_url = href if href.startswith("http") else f"https://ylnime.com/{href.lstrip('/')}"
        if full_url in seen:
            continue
        seen.add(full_url)

        m_ep = re.search(r"(?:episode|ep|eps)\s*(\d+)", el.get_text(" ", strip=True), re.I)
        status = f"Eps {m_ep.group(1)}" if m_ep else "Eps"
        updates.append({"judul": title, "status": status, "url": full_url})

    return updates
