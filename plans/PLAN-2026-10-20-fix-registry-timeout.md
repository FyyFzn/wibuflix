# PLAN: Fix ProviderRegistry Timeout Race Blocking YLnime and Oploverz

## 1. Goal and Scope

**Goal:** Eliminate timeout race condition in `ProviderRegistry.fetchEpisodes` that causes YLnime and Oploverz scrapers to fail with "Scrape timeout setelah 20s" errors.

**What's in:**
- Increase `fetchEpisodes` default timeout from 20s to 40s in `src/services/ProviderRegistry.js`
- Verify YLnime and Oploverz scrapers complete successfully after fix

**What's out:**
- Refactoring timeout architecture (removing wrapper entirely)
- Changing Python service timeouts
- Changing individual scraper timeouts
- Touching other providers or scrapers

**Done means:**
- `fetchEpisodes` timeout allows 35s axios + 5s buffer
- YLnime series request completes without timeout error
- Oploverz series request completes without timeout error
- Server starts cleanly after change

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
| F1 | VERIFIED | `src/services/ProviderRegistry.js:132-139` | `fetchEpisodes` wraps `plugin.scrapeEpisodes()` with 20s timeout via `Promise.race`. Timeout message format matches log: `[${plugin.name}] Scrape timeout setelah ${timeoutMs / 1000}s` |
| F2 | VERIFIED | `src/services/scrapers/ylnimeScraper.js:38` | YLnime axios call to Python service has 35s timeout: `axios.post(..., { timeout: 35000 })` |
| F3 | VERIFIED | `python/fetcher.py:25` | Python `fetch_html()` has 30s timeout: `TIMEOUT = 30` |
| F4 | VERIFIED | Logs | Error format `[YLnime] Scrape timeout setelah 20s` confirms Registry timeout fires before axios 35s or Python 30s can complete |
| F5 | VERIFIED | Logs | Oploverz has identical timeout pattern: `[Oploverz] Scrape timeout setelah 20s` |
| F6 | VERIFIED | `src/services/ProviderRegistry.js:137` | Timeout calculation: `timeoutMs / 1000` shows in error → 20000 / 1000 = "20s" |

## 4. Phases and Steps

### Phase 1: Fix Timeout Race

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-20-fix-registry-timeout.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-20-fix-registry-timeout.md`
- **Rollback:** `git revert HEAD`

**Step 1 — Increase fetchEpisodes timeout to 40s**
- **Files:** `src/services/ProviderRegistry.js`
- **Change:** Line 132, change `static async fetchEpisodes(url, timeoutMs = 20000)` to `static async fetchEpisodes(url, timeoutMs = 40000)`
- **Rationale:** 40s = 35s (max axios timeout in scrapers) + 5s buffer for network overhead
- **Verify:** 
  1. `node src/server.js` starts without errors
  2. `grep -n "timeoutMs = 40000" src/services/ProviderRegistry.js` returns line 132
- **Commit message:** `fix(ProviderRegistry): increase fetchEpisodes timeout to 40s to prevent race with scraper timeouts`
- **Rollback:** `git revert HEAD`

**Step 2 — Test YLnime scraper**
- **Files:** None (manual verification)
- **Change:** None
- **Verify:** Make HTTP request to test YLnime series endpoint:
  ```bash
  curl -X POST http://localhost:3000/api/anime/scrape/episodes \
    -H "Content-Type: application/json" \
    -d '{"url":"https://ylnime.com/?series=naruto-shippuuden-all-fixed"}' \
    --max-time 45
  ```
  Expected: 200 response with `daftar_episode` array populated, no timeout error
- **Rollback:** N/A (read-only test)

**Step 3 — Test Oploverz scraper**
- **Files:** None (manual verification)
- **Change:** None
- **Verify:** Make HTTP request to test Oploverz series endpoint:
  ```bash
  curl -X POST http://localhost:3000/api/anime/scrape/episodes \
    -H "Content-Type: application/json" \
    -d '{"url":"https://oploverz.site/series/naruto-shippuuden"}' \
    --max-time 45
  ```
  Expected: 200 response with `daftar_episode` array populated, no timeout error
- **Rollback:** N/A (read-only test)

## 5. Needs My Decision

None. Solution is straightforward: increase timeout ceiling to accommodate existing downstream timeouts.

## 6. Risks

**Phase 1:**
- **Risk:** Slower scrapers could hang for up to 40s before failing
- **Mitigation:** Python `fetch_html()` and axios already enforce 30-35s limits; 40s is only the outer safety net
- **Detection:** Monitor logs for "Scrape timeout setelah 40s" messages indicating legitimate slow scrapers

## 7. Noticed but Out of Scope

- **Layered timeout architecture:** Registry timeout wrapper adds complexity. Could remove entirely and rely on axios/fetch timeouts alone. This would prevent race conditions permanently but requires broader testing.
- **Provider-specific timeout config:** Some providers (fast CDN-backed sites) could use shorter timeouts; slow providers need longer. Could add `scraperMeta.timeoutMs` per provider.
- **Nimegami empty results:** Logs show "Tidak ada episode ditemukan" but this is upstream site issue (no episodes uploaded), not scraper bug.
- **Kuronime decrypt failures:** animeku.org returning 500 errors or timeouts. Separate infrastructure issue unrelated to Registry timeout.

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.

The senior model will run verify-plan, confirm correctness, then update the skill.
