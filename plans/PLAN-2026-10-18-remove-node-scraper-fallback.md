# PLAN: Remove Node.js Scraper Fallback — Python as Single Source

## 1. Goal and Scope

Remove all Node.js/Puppeteer fallback scraping logic from the four scrapers that were
migrated to Python. Python is the sole scraping path. If Python fails, the function fails
loudly with a clear error — no silent fallback to a weaker scraper.

In scope:
- src/services/scrapers/oploverzScraper.js
- src/services/scrapers/kuronimeScraper.js
- src/services/scrapers/nimegamiScraper.js
- src/services/scrapers/ylnimeScraper.js

Out of scope:
- src/services/scrapers/samehadakuScraper.js (already Python-only, no fallback)
- src/services/scrapers/otakudesuScraper.js (uses its own npm package, unrelated)
- src/services/scrapers/neosatsuScraperService.js (native HTTP, unrelated)
- Any extractor, sync, or stream file.

"Done" means each of the four scrapers calls Python only for series and latest, with no
try/catch fallback to fetchWithCF or Puppeteer. Server starts cleanly.

---

## 2. Executor Rules

- Follow phases and steps in order, one at a time.
- Commit after each step: `git add -A && git commit -m "<type>(<scope>): <step description>"`.
- If the code does not match what a step describes, STOP and report the mismatch. Do not improvise or fix adjacent things.
- Do not add dependencies, rename things, or change behavior outside the step.
- Run the step's verification before moving on. If it fails, stop and report.
- For backend steps: verify server starts with `node src/server.js` before committing.
- Do NOT update any skill file. Skill updates are handled by the senior model after verification.

---

## 3. Findings

| ID | Status | File:Line | Description |
|----|--------|-----------|-------------|
| F1 | VERIFIED | oploverzScraper.js:31–40 | Python try/catch with Node fetchWithCF fallback in getOploverzEpisodes |
| F2 | VERIFIED | oploverzScraper.js:282–340 | Python try/catch with Puppeteer pool fallback in getOploverzLatestUpdates |
| F3 | VERIFIED | oploverzScraper.js:150 | getOploverzServers uses fetchWithCF directly (no Python path exists — keep as-is, servers scraping was never migrated) |
| F4 | VERIFIED | kuronimeScraper.js:35–44 | Python try/catch with Node fetchWithCF fallback in getKuronimeEpisodes |
| F5 | VERIFIED | kuronimeScraper.js:365–380 | Python try/catch with fetchWithCF fallback in getKuronimeLatestUpdates |
| F6 | VERIFIED | kuronimeScraper.js:51–162 | Entire Node parsing block after fallback in getKuronimeEpisodes (large) |
| F7 | VERIFIED | nimegamiScraper.js:57–66 | Python try/catch with fetchWithCF fallback in getNimegamiEpisodes |
| F8 | VERIFIED | nimegamiScraper.js:381–395 | Python try/catch with fetchWithCF fallback in getNimegamiLatestUpdates |
| F9 | VERIFIED | ylnimeScraper.js:39–48 | Python try/catch with fetchWithCF fallback in getYlnimeEpisodes |
| F10 | VERIFIED | ylnimeScraper.js:334–344 | Python try/catch with fetchWithCF fallback in getYlnimeLatestUpdates |

Note on server scraping (getOploverzServers, getKuronimeServers, etc.):
These functions scrape individual episode pages for video server links. They were NOT
migrated to Python and must NOT be touched in this plan. They are the correct Node path
for a different job (video server extraction, not episode listing).

---

## 4. Phases and Steps

### Phase 1 — Oploverz

#### Step 1.1 — Commit plan file alone

- **Files:** `plans/PLAN-2026-10-18-remove-node-scraper-fallback.md`
- **Change:** No source code change. Stage and commit the plan file only.
- **Verify:** `git log --oneline -1` shows only the plan file in the diff.
- **Commit message:** `docs(plans): add PLAN-2026-10-18-remove-node-scraper-fallback.md`
- **Rollback:** `git revert HEAD`

---

#### Step 1.2 — Remove Node fallback from getOploverzEpisodes

**Files:** `src/services/scrapers/oploverzScraper.js`

**Change:** In `getOploverzEpisodes`, replace the entire try/catch Python block + Node fallback
block with a direct Python call that throws on failure:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/oploverz/series`, { url: targetUrl }, { timeout: 35000 });
if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
    throw new Error(`Python scraper mengembalikan data kosong untuk ${targetUrl}`);
}
cache.set(cacheKey, data);
return data;
```

Remove everything after this block that belongs to the old Node path:
- The `console.log([Oploverz Fast Fetch])` line
- The `let slot;` declaration
- The entire `try { const fetchRes = await fetchWithCF(...) ... } finally { if (slot) releaseToPool(slot); }` block

**Also update:** Remove unused imports at the top of the file if they are now only used by
removed code. Check each import: `releaseToPool`, `fetchWithCF`, `cheerio`. Only remove an
import if it is no longer referenced anywhere else in the file after this step.
`releaseToPool` may still be used by `getOploverzServers` — check before removing.

**Verify:** `node src/server.js` starts without error. Confirm `fetchWithCF` is not called
inside `getOploverzEpisodes`: `grep -n "fetchWithCF" src/services/scrapers/oploverzScraper.js`
— the only remaining hits should be inside `getOploverzServers`, not in `getOploverzEpisodes`.

**Rollback:** `git revert HEAD`

---

#### Step 1.3 — Remove Puppeteer fallback from getOploverzLatestUpdates

**Files:** `src/services/scrapers/oploverzScraper.js`

**Change:** In `getOploverzLatestUpdates`, replace the try/catch Python block + Puppeteer
fallback with a direct Python call that throws on failure:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/oploverz/latest`, { url }, { timeout: 35000 });
if (!Array.isArray(data) || data.length === 0) {
    throw new Error('[Oploverz] Python latest scraper mengembalikan data kosong');
}
return data;
```

Remove everything after this that belongs to the old Puppeteer path:
- The `console.warn` fallback log line
- The dynamic imports of `acquireFromPool`, `releaseToPool`, `cheerio`
- The entire `let slot; const updates = []; try { slot = await acquireFromPool() ... } finally { ... }` block
- The final `return updates;`

**Also update:** After both Step 1.2 and 1.3 are done, check if `releaseToPool` import at
the top of the file is still used anywhere. If `getOploverzServers` still uses it, keep it.
If not, remove it.

**Verify:** `node src/server.js` starts without error. Confirm no `acquireFromPool` or
Puppeteer reference remains in the file:
`grep -n "acquireFromPool\|Puppeteer\|puppeteer" src/services/scrapers/oploverzScraper.js`
— expected: no output.

**Rollback:** `git revert HEAD`

---

### Phase 2 — Kuronime

#### Step 2.1 — Remove Node fallback from getKuronimeEpisodes

**Files:** `src/services/scrapers/kuronimeScraper.js`

**Change:** In `getKuronimeEpisodes`, the function currently tries Python first, then falls
back to a large Node/Puppeteer parsing block. Replace the entire function body after the
cache-hit check with a direct Python call:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/kuronime/series`, { url: animeUrl }, { timeout: 35000 });
if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
    throw new Error(`Python scraper mengembalikan data kosong untuk ${animeUrl}`);
}
cache.set(cacheKey, data);
return data;
```

Remove everything that follows — the Node/Puppeteer fallback block is large (~100 lines).
Remove from the `console.warn([Kuronime] Python scraper service gagal...)` line all the way
to the end of the function including the `finally { if (slot) releaseToPool(slot); }`.

Note: `getKuronimeServers` still uses `fetchWithCF` and Puppeteer — do NOT touch it.

**Also update:** Check top-level imports after removal. Only remove `fetchWithCF` import
if it is no longer referenced anywhere in the file. `releaseToPool` is likely still used
by `getKuronimeServers` — verify before touching.

**Verify:** `node src/server.js` starts without error. Confirm the fallback block is gone:
`grep -n "fallback ke fetchWithCF" src/services/scrapers/kuronimeScraper.js` — expected:
no output.

**Rollback:** `git revert HEAD`

---

#### Step 2.2 — Remove Node fallback from getKuronimeLatestUpdates

**Files:** `src/services/scrapers/kuronimeScraper.js`

**Change:** In `getKuronimeLatestUpdates`, replace the try/catch Python block + fetchWithCF
fallback with a direct Python call:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/kuronime/latest`, { url }, { timeout: 35000 });
if (!Array.isArray(data) || data.length === 0) {
    throw new Error('[Kuronime] Python latest scraper mengembalikan data kosong');
}
return data;
```

Remove the fallback block: the `console.warn` line, the dynamic import of `fetchWithCF`,
and the `try { fetchRes = await fetchWithCF(...) ... }` block including its parsing logic.

**Verify:** `node src/server.js` starts without error.
`grep -n "fallback ke fetchWithCF" src/services/scrapers/kuronimeScraper.js` — expected:
no output.

**Rollback:** `git revert HEAD`

---

### Phase 3 — Nimegami

#### Step 3.1 — Remove Node fallback from getNimegamiEpisodes

**Files:** `src/services/scrapers/nimegamiScraper.js`

**Change:** In `getNimegamiEpisodes`, replace the try/catch Python block + fetchWithCF
fallback with a direct Python call:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/nimegami/series`, { url: cleanUrl }, { timeout: 35000 });
if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
    throw new Error(`Python scraper mengembalikan data kosong untuk ${cleanUrl}`);
}
cache.set(cacheKey, data);
return data;
```

Remove the `console.warn` fallback line and the entire Node parsing block that follows it
inside `getNimegamiEpisodes`.

Note: nimegamiScraper.js has other functions that use `fetchWithCF` internally (server
scraping etc.) — do NOT touch those.

**Verify:** `node src/server.js` starts without error.
`grep -n "fallback ke fetchWithCF" src/services/scrapers/nimegamiScraper.js` — confirm
only remaining hits (if any) are outside `getNimegamiEpisodes`.

**Rollback:** `git revert HEAD`

---

#### Step 3.2 — Remove Node fallback from getNimegamiLatestUpdates

**Files:** `src/services/scrapers/nimegamiScraper.js`

**Change:** In `getNimegamiLatestUpdates`, replace the try/catch Python block + fetchWithCF
fallback with a direct Python call:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/nimegami/latest`, { url }, { timeout: 35000 });
if (!Array.isArray(data) || data.length === 0) {
    throw new Error('[Nimegami] Python latest scraper mengembalikan data kosong');
}
return data;
```

Remove the fallback: `console.warn` line, dynamic import of `fetchWithCF`, and the
fetchWithCF parsing block.

**Verify:** `node src/server.js` starts without error.
`grep -n "acquireFromPool\|fallback ke fetchWithCF" src/services/scrapers/nimegamiScraper.js`
— expected: no output.

**Rollback:** `git revert HEAD`

---

### Phase 4 — YLnime

#### Step 4.1 — Remove Node fallback from getYlnimeEpisodes

**Files:** `src/services/scrapers/ylnimeScraper.js`

**Change:** In `getYlnimeEpisodes`, replace the try/catch Python block + fetchWithCF
fallback with a direct Python call:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/ylnime/series`, { url: animeUrl }, { timeout: 35000 });
if (!data || !data.daftar_episode || data.daftar_episode.length === 0) {
    throw new Error(`Python scraper mengembalikan data kosong untuk ${animeUrl}`);
}
cache.set(cacheKey, data);
return data;
```

Remove the `console.warn` fallback line and the Node parsing block inside `getYlnimeEpisodes`.

Note: ylnimeScraper.js has other functions using `fetchWithCF` — do NOT touch those.

**Verify:** `node src/server.js` starts without error.
`grep -n "fallback ke fetchWithCF" src/services/scrapers/ylnimeScraper.js` — expected:
only hits outside `getYlnimeEpisodes` (other functions), or no output.

**Rollback:** `git revert HEAD`

---

#### Step 4.2 — Remove Node fallback from getYlnimeLatestUpdates

**Files:** `src/services/scrapers/ylnimeScraper.js`

**Change:** In `getYlnimeLatestUpdates`, replace the try/catch Python block + fetchWithCF
fallback with a direct Python call:

```js
const { data } = await axios.post(`${SCRAPER_BASE}/scrape/ylnime/latest`, { url: `${BASE_URL}/index.php?terbaru=1` }, { timeout: 35000 });
if (!Array.isArray(data) || data.length === 0) {
    throw new Error('[YLnime] Python latest scraper mengembalikan data kosong');
}
return data;
```

Remove the fallback: `console.warn` line, dynamic import of `fetchWithCF`, and the
fetchWithCF parsing block.

**Verify:** `node src/server.js` starts without error.
`grep -n "fallback ke fetchWithCF" src/services/scrapers/ylnimeScraper.js` — expected:
no output inside `getYlnimeLatestUpdates`. Then do a final pass:
`grep -rn "fallback ke fetchWithCF\|fallback ke Puppeteer" src/services/scrapers/` —
expected: no output across all four files.

**Rollback:** `git revert HEAD`

---

## 5. Needs My Decision

None. All findings verified. Scope is clear.

---

## 6. Risks

| Phase | Risk | How to notice |
|-------|------|---------------|
| All phases | Python service is down at deploy time — scrapers fail loudly instead of silently degrading | Episode list returns empty/error on frontend; monitor Python service health |
| Phase 1–4 | Unused import left behind causes no runtime error but is dead code | grep after each step to confirm |
| Phase 2 (Kuronime) | getKuronimeEpisodes fallback block is large — partial removal leaves syntax error | Server startup error; revert and redo |

---

## 7. Noticed but Out of Scope

- Server scraping functions (getOploverzServers, getKuronimeServers, etc.) still use
  fetchWithCF — correct, these were never migrated to Python and are a different concern.
- kuronimeDecryptor.js AES decryption logic inside getKuronimeServers — untouched.
- After this plan, `fetchWithCF` import may become unused in some scrapers if server
  scraping is also eventually migrated — future plan.

## 8. After Execution

When all steps are committed, report back to the senior model:
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.
The senior model will run verify-plan, confirm correctness, then update the skill.
