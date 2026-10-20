"""
parsers/ylnime.py
Tanggung jawab tunggal: Mem-parsing halaman HTML YLnime (series dan latest updates) menjadi struktur data dictionary.
"""

import json
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


def parse_episode(html: str, episode_url: str) -> dict:
    """
    Parsing halaman episode YLnime.
    Mengekstrak data streams dari JavaScript (const streams = [...]).
    Mengembalikan: { judul, servers: [{nama, url, type, namaHost, provider}] }
    """
    soup = BeautifulSoup(html, "html.parser")

    # Ambil judul episode dari heading atau title
    raw_title = soup.select_one("h1, h2")
    if raw_title:
        judul = raw_title.get_text(strip=True)
    elif soup.title:
        judul = re.sub(r"[-|].*$", "", soup.title.get_text(strip=True)).strip()
    else:
        judul = "Episode"

    servers = []
    seen_urls = set()

    for script in soup.find_all("script"):
        code = script.string or script.get_text() or ""
        if "const streams =" in code:
            m = re.search(r"const\s+streams\s*=\s*(\[.*?\]);", code, re.DOTALL)
            if m:
                try:
                    streams_json = json.loads(m.group(1))
                    for s in streams_json:
                        link = s.get("link", "")
                        if not link or link in seen_urls:
                            continue
                        seen_urls.add(link)

                        reso = s.get("reso", "")
                        if ".mp4" in link:
                            stream_type = "mp4"
                        elif ".m3u8" in link:
                            stream_type = "hls"
                        else:
                            stream_type = "iframe"

                        nama = f"YLnime {reso}".strip()
                        nama_host = "YLnime Stream"

                        if "pixeldrain" in link or "pxl" in link:
                            nama = f"Pixeldrain {reso}".strip()
                            nama_host = "Pixeldrain"
                            stream_type = "iframe"

                        servers.append({
                            "nama": nama,
                            "url": link,
                            "type": stream_type,
                            "namaHost": nama_host,
                            "provider": "ylnime"
                        })
                except Exception:
                    pass

    # Fallback jika tidak ada const streams: cek iframe dan video
    if not servers:
        for iframe in soup.find_all("iframe"):
            src = iframe.get("src") or iframe.get("data-src") or ""
            if src and src not in seen_urls:
                seen_urls.add(src)
                full_src = src if src.startswith("http") else f"https:{src}"
                servers.append({
                    "nama": f"Server {len(servers) + 1}",
                    "url": full_src,
                    "type": "iframe",
                    "namaHost": "YLnime Embed",
                    "provider": "ylnime"
                })

        for video in soup.find_all("video"):
            src = video.get("src") or ""
            if src and src not in seen_urls:
                seen_urls.add(src)
                servers.append({
                    "nama": f"Direct {len(servers) + 1}",
                    "url": src,
                    "type": "direct",
                    "namaHost": "Direct",
                    "provider": "ylnime"
                })

    return {
        "judul": judul,
        "servers": servers
    }


def find_episode_link(html: str, target_num: int) -> str | None:
    """
    Mencari URL episode asli (&episode=al-XXXXX-N) dari HTML halaman seri
    berdasarkan target nomor episode.
    """
    soup = BeautifulSoup(html, "html.parser")
    for a in soup.find_all("a"):
        href = a.get("href", "")
        m_link = re.search(r"episode=[^&]+-(\d+)", href)
        if m_link and int(m_link.group(1)) == target_num:
            if href.startswith("?"):
                return f"https://ylnime.com/index.php{href}"
            elif href.startswith("http"):
                return href
            else:
                return f"https://ylnime.com/{href.lstrip('/')}"
    return None
