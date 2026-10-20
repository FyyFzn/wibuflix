# PLAN: Route YLnime Episode Scraping Through Python Service

## 1. Goal and Scope

**Goal:** Fix YLnime server extraction (0 servers returned) by routing episode page scraping through Python curl_cffi service to bypass 403 Forbidden blocks.

**What's in:**
- Add `/scrape/ylnime/episode` endpoint in Python service
- Add `parse_episode()` function in `python/parsers/ylnime.py` to extract `const streams` JavaScript
- Update Node `getYlnimeServers()` to call Python endpoint instead of raw axios
- Verify YLnime returns playable animeverse.id video URLs

**What's out:**
- Changing animeverse.id video extractor logic (already works with proper referer/cookies)
- Touching other providers
- Modifying catalog/latest scraping (already working through Python)
- Changing timeout values (already fixed in previous plan)

**Done means:**
- YLnime episode pages fetched via Python curl_cffi (bypasses 403)
- `const streams` JavaScript parsed and animeverse.id URLs extracted
- `getYlnimeServers()` returns non-zero servers for test episode
- Video URLs playable through existing videoExtractor.js logic

## 2. Executor Rules

- Follow phases and steps in order, one at a time.
- Commit after each step: `git add -A && git commit -m "<type>(<scope>): <step description>"`.
- If the code does not match what a step describes, STOP and report the mismatch.
  Do not improvise or fix adjacent things.
- Do not add dependencies, rename things, or change behavior outside the step.
- Run the step's verification before moving on. If it fails, stop and report.
- For backend steps: verify server starts with `node src/server.js` before committing.
- For frontend steps: verify types compile with `npx tsc --noEmit` before committing.
- Do NOT update any skill file. Skill updates are handled by the senior model after verification.

## 3. Findings

| ID | Status | File:Line | Description |
|----|--------|-----------|-------------|
| F1 | VERIFIED | `src/services/scrapers/ylnimeScraper.js:56` | `getYlnimeServers()` fetches episode pages with raw axios: `axios.get(episodeUrl, { headers, timeout: 15000 })`. Gets 403 Forbidden from YLnime. |
| F2 | VERIFIED | `src/services/scrapers/ylnimeScraper.js:138` | Resolution variant pages also fetched with raw axios: `axios.get(link, { timeout: 15000 })`. Also blocked. |
| F3 | VERIFIED | `src/services/scrapers/ylnimeScraper.js:72-111` | `parseStreams()` extracts `const streams = [...]` JavaScript from HTML and parses JSON to get video URLs. Returns array with `{nama, url, type, namaHost}` objects. |
| F4 | VERIFIED | Manual test | Direct curl to episode page returns 403. Python curl_cffi bypasses it (tested with series endpoint). |
| F5 | VERIFIED | `python/parsers/ylnime.py` | Only has `parse_series()` and `parse_latest()`. No episode parser exists. |
| F6 | VERIFIED | `python/scraper_service.py:255-272` | YLnime has `/scrape/ylnime/series` and `/scrape/ylnime/latest` endpoints. No episode endpoint. |
| F7 | VERIFIED | `src/services/extractors/videoExtractor.js:396-410` | animeverse.id URLs already handled with special referer + CF cookies. Once URLs extracted, playback should work. |

## 4. Phases and Steps

### Phase 1: Add Python Episode Parser

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-20-ylnime-episode-python-bypass.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-20-ylnime-episode-python-bypass.md`
- **Rollback:** `git revert HEAD`

**Step 1 — Add parse_episode() to python/parsers/ylnime.py**
- **Files:** `python/parsers/ylnime.py`
- **Change:** Add new function `parse_episode(html: str, episode_url: str) -> dict` after `parse_latest()`. Function must:
  1. Parse HTML with BeautifulSoup
  2. Find all `<script>` tags containing `const streams =`
  3. Extract JSON array from `const streams = [...];` using regex `const\s+streams\s*=\s*(\[.*?\]);`
  4. Parse JSON and build servers list with fields: `{nama, url, type, namaHost, provider: 'ylnime'}`
  5. Detect pixeldrain URLs and set appropriate `namaHost` and `type`
  6. Also extract episode title from `<h1>`, `<h2>`, or `<title>` tag
  7. Return `{judul: str, servers: [{nama, url, type, namaHost, provider}]}`
  8. Return empty servers list if no `const streams` found (upstream has no video uploaded)
- **Verify:**
  1. `python3 -m py_compile python/parsers/ylnime.py` exits 0
  2. Manual test: `python3 -c "from python.parsers.ylnime import parse_episode; print('imported')"` succeeds
- **Commit message:** `feat(ylnime_parser): add parse_episode to extract const streams JavaScript from episode pages`
- **Rollback:** `git revert HEAD`

**Step 2 — Add /scrape/ylnime/episode endpoint to Python service**
- **Files:** `python/scraper_service.py`
- **Change:** After `/scrape/ylnime/latest` endpoint (line 275-288), add new endpoint:
  ```python
  @app.route("/scrape/ylnime/episode", methods=["POST"])
  def scrape_ylnime_episode():
      body = request.get_json(silent=True) or {}
      url = body.get("url", "").strip()
      if not url:
          return jsonify({"error": "Parameter 'url' wajib diisi"}), 400
      try:
          html = fetch_html(url)
          result = parse_ylnime_episode(html, url)
          if not result["servers"]:
              log.warning(f"Tidak ada server ditemukan untuk: {url}")
          return jsonify(result), 200
      except RuntimeError as e:
          log.error(str(e))
          return jsonify({"error": str(e)}), 502
      except Exception as e:
          log.error(f"Error scraping ylnime episode {url}: {e}")
          return jsonify({"error": str(e)}), 500
  ```
- **Also update:** Import statement at top (around line 37): add `parse_episode as parse_ylnime_episode` to the ylnime import line
- **Verify:**
  1. `python3 -m py_compile python/scraper_service.py` exits 0
  2. Start Python service: `cd python && python3 scraper_service.py` (background or separate terminal)
  3. Test endpoint: `curl -X POST http://localhost:5001/scrape/ylnime/episode -H "Content-Type: application/json" -d '{"url":"https://ylnime.com/index.php?series=naruto-shippuuden-all-fixed&ep=1"}' -s | grep -o '"servers":\[' | wc -l` returns 1
  4. Kill Python service
- **Commit message:** `feat(scraper_service): add /scrape/ylnime/episode endpoint for CF-bypass episode scraping`
- **Rollback:** `git revert HEAD`

### Phase 2: Update Node Scraper to Use Python Endpoint

**Step 3 — Replace axios calls in getYlnimeServers with Python service call**
- **Files:** `src/services/scrapers/ylnimeScraper.js`
- **Change:** 
  1. Replace lines 50-229 (entire `getYlnimeServers` function body) with Python service call:
     ```javascript
     export async function getYlnimeServers(episodeUrl) {
         const cacheKey = `ylnime_srv_${episodeUrl}`;
         const cached = cache.get(cacheKey);
         if (cached) return cached;

         try {
             const { data } = await axios.post(
                 `${SCRAPER_BASE}/scrape/ylnime/episode`,
                 { url: episodeUrl },
                 { timeout: 35000 }
             );
             
             if (!data || !data.servers || data.servers.length === 0) {
                 console.warn(`[YLnime] Tidak ada server ditemukan untuk ${episodeUrl}`);
                 return { judul: data?.judul || 'Episode', servers: [], nav_prev: null, nav_next: null };
             }

             // Normalize server structure to match expected format
             const servers = data.servers.map((s, idx) => ({
                 ...s,
                 nume: s.nume || `${idx + 1}`,
                 id: s.id || `${idx + 1}`,
                 post: s.post || '',
                 tipe: s.type,
                 aktif: true,
                 iframeUrl: s.url,
                 source: 'ylnime',
                 provider: 'ylnime'
             }));

             const result = {
                 judul: data.judul || 'Episode',
                 servers,
                 nav_prev: null,
                 nav_next: null
             };

             cache.set(cacheKey, result);
             return result;
         } catch (err) {
             console.error(`[YLnime] Error fetching servers for ${episodeUrl}:`, err.message);
             return { judul: 'Episode', servers: [], nav_prev: null, nav_next: null };
         }
     }
     ```
  2. Remove unused imports if any (cheerio no longer needed for server extraction, but keep for potential fallback logic)
  3. Keep `AX_HEADERS` definition (not used but harmless)
- **Verify:**
  1. `node src/server.js` starts without errors
  2. Test via Node: `node -e "import('./src/services/scrapers/ylnimeScraper.js').then(async m => { const r = await m.scrapeServers('https://ylnime.com/index.php?series=naruto-shippuuden-all-fixed&ep=1'); console.log('Servers:', r.servers.length); })"`
  3. Expected: "Servers: N" where N > 0
- **Commit message:** `fix(ylnimeScraper): route episode scraping through Python service to bypass 403`
- **Rollback:** `git revert HEAD`

**Step 4 — Integration test with video extraction**
- **Files:** None (manual verification)
- **Change:** None
- **Verify:** Test full pipeline from scraper → extractor:
  ```bash
  node -e "
  import('./src/services/scrapers/ylnimeScraper.js').then(async m => {
    const servers = await m.scrapeServers('https://ylnime.com/index.php?series=naruto-shippuuden-all-fixed&ep=1');
    console.log('Total servers:', servers.servers.length);
    if (servers.servers[0]) {
      console.log('First server URL:', servers.servers[0].url);
      console.log('Contains animeverse.id:', servers.servers[0].url.includes('animeverse.id'));
    }
  });
  "
  ```
  Expected:
  - Total servers > 0
  - URL contains `animeverse.id` or `pixeldrain` or direct video format
- **Rollback:** N/A (read-only test)

## 5. Needs My Decision

None. Approach is straightforward: move episode HTML fetch from Node axios (blocked) to Python curl_cffi (bypasses 403), then extract same `const streams` JavaScript that Node was trying to parse.

## 6. Risks

**Phase 1:**
- **Risk:** YLnime site structure changed and `const streams` JavaScript no longer present
- **Mitigation:** Test against live episode page; if missing, fallback to iframe/video tag extraction (already in old Node code)
- **Detection:** Endpoint returns empty servers array; check raw HTML from Python to confirm structure

**Phase 2:**
- **Risk:** Python service down causes all YLnime requests to fail
- **Mitigation:** Node scraper already returns empty servers on error (graceful degradation)
- **Detection:** Node error logs show connection refused to localhost:5001

## 7. Noticed but Out of Scope

- **Generic episode scraping for all providers:** Other providers (Samehadaku, Kuronime) also use raw axios for episode pages. If they start getting 403, same Python-routing pattern applies.
- **Resolution variant fetching:** Current Node code fetches multiple resolution pages in parallel (line 138). Python endpoint only handles single episode URL. Multi-resolution support would need additional endpoint parameter or separate calls.
- **Fallback iframe/video tag extraction:** Old Node code has fallback logic for `<iframe>`, `<video>`, and download links. Python parser (Step 1) should include these as fallback if `const streams` missing.
- **Cheerio dependency cleanup:** After this change, ylnimeScraper.js only uses cheerio for `extractHostname()` helper. Could be replaced with native `URL` constructor.
- **Oploverz timeout issue:** Original logs showed Oploverz also timing out. Likely same 403 issue. Needs separate investigation.

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.

The senior model will run verify-plan, confirm correctness, then update the skill.
