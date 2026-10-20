# PLAN: Bypass Cloudflare for animeku.org API via cloudscraper

## 1. Goal and Scope

**Goal:** Make Kuronime video decryption work by bypassing animeku.org's Cloudflare protection.

**What's in:**
- Add `cloudscraper` Python library as a dependency
- Replace curl_cffi with cloudscraper for animeku.org API POST requests only
- Keep curl_cffi for all other scraping (HTML fetches)
- Preserve existing logging, correlation IDs, and retry logic
- Update Dockerfile to include the new dependency

**What's out:**
- Changing the decrypt endpoint API contract (Node still sends `{token, requestId}`)
- Changing how tokens are extracted from Kuronime episode pages
- Changing any other scraper or fetch logic
- Adding FlareSolverr or external services

**Done means:**
- `POST /scrape/kuronime/decrypt` returns 200 with decrypted sources when given a valid token
- Azure logs show `Success: returning decrypted sources` instead of `Animeku returned status 403`
- No regression in other scrapers (samehadaku, oploverz, nimegami, ylnime still work)

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
| F1 | VERIFIED | `python/scraper_service.py:137-192` | Decrypt endpoint uses curl_cffi `_session.post()` directly with Chrome 124 impersonation. Gets 403 Cloudflare challenge page on both attempts. |
| F2 | VERIFIED | `python/fetcher.py:12,25` | curl_cffi session is global, shared across all scraping. Impersonate set to `chrome124`. |
| F3 | VERIFIED | `python/requirements.txt:1-3` | Current deps: flask, curl_cffi, beautifulsoup4. No cloudscraper. |
| F4 | VERIFIED | `python/scraper_service.py:150-159,169-178` | animeku.org POST uses headers: Content-Type, Referer, Origin. JSON body `{"id": token}`. |
| F5 | VERIFIED | `python/fetcher.py:55-98` | `fetch_html()` is only for HTML GET requests. Decrypt endpoint directly calls `_session.post()`, bypassing fetch_html. |
| F6 | VERIFIED | `Dockerfile:24-26` | Python requirements installed via `pip3 install --break-system-packages -r python/requirements.txt` at build time. |
| F7 | VERIFIED | Azure logs | Both attempts return 403 with `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>` — Cloudflare challenge page, not API response. |

## 4. Phases and Steps

### Phase 1: Add cloudscraper dependency

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-20-animeku-cloudflare-bypass.md`
- **Change:** no source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-20-animeku-cloudflare-bypass.md`
- **Rollback:** `git revert HEAD`

**Step 1.1 — Add cloudscraper to Python requirements**
- **Files:** `python/requirements.txt`
- **Change:** Append `cloudscraper==1.2.72` as line 4 (latest stable as of Oct 2026).
- **Verify:** `cat python/requirements.txt` shows 4 lines ending with cloudscraper.
- **Commit message:** `chore(python): add cloudscraper dependency for CF bypass`
- **Rollback:** `git revert HEAD`

**Step 1.2 — Install cloudscraper locally**
- **Files:** None (local dev environment only)
- **Change:** Run `cd python && pip install cloudscraper==1.2.72` to test locally.
- **Verify:** `pip show cloudscraper` returns version 1.2.72.
- **Commit message:** N/A (no commit, verification step only)
- **Rollback:** N/A

**Step 1.3 — Update Dockerfile**
- **Files:** `Dockerfile`
- **Change:** No changes needed. Line 26 already installs from `python/requirements.txt`. Verify this line exists: `RUN pip3 install --no-cache-dir --break-system-packages -r python/requirements.txt`
- **Verify:** `grep "pip3 install.*requirements.txt" Dockerfile` returns the install line.
- **Commit message:** N/A (verification only, no code change)
- **Rollback:** N/A

### Phase 2: Replace curl_cffi with cloudscraper for animeku.org

**Step 2.1 — Import cloudscraper in scraper_service.py**
- **Files:** `python/scraper_service.py`
- **Change:** Add `import cloudscraper` after line 20 (after `from flask import Flask, request, jsonify`).
- **Verify:** `grep "import cloudscraper" python/scraper_service.py` returns one match.
- **Commit message:** `feat(scraper_service): import cloudscraper for CF bypass`
- **Rollback:** `git revert HEAD`

**Step 2.2 — Create cloudscraper instance for animeku.org**
- **Files:** `python/scraper_service.py`
- **Change:** Add after line 41 (after `log = logging.getLogger(__name__)`):
  ```python
  # Cloudscraper instance for animeku.org API (bypasses Cloudflare)
  _animeku_scraper = cloudscraper.create_scraper(
      browser={'browser': 'chrome', 'platform': 'windows', 'desktop': True}
  )
  ```
- **Verify:** `grep "_animeku_scraper" python/scraper_service.py` returns the definition.
- **Commit message:** `feat(scraper_service): create cloudscraper instance for animeku API`
- **Rollback:** `git revert HEAD`

**Step 2.3 — Replace curl_cffi POST with cloudscraper POST in decrypt endpoint**
- **Files:** `python/scraper_service.py`
- **Change:** In `scrape_kuronime_decrypt()` function (lines 137-192):
  - Replace first POST (lines 149-159) with:
    ```python
    resp = _animeku_scraper.post(
        "https://animeku.org/api/v9/sources",
        json={"id": token},
        headers={
            "Content-Type": "application/json",
            "Referer": "https://kuronime.sbs/",
            "Origin": "https://kuronime.sbs",
        },
        timeout=15,
    )
    ```
  - Remove `with _session_lock:` wrapper (cloudscraper handles its own concurrency).
  - Keep the status check and logging at line 161.
  - Replace retry POST (lines 169-178) with the same cloudscraper call (no session reset needed — cloudscraper auto-retries CF challenges).
  - Remove `_force_reset_session()` call and `time.sleep(2)` (lines 166-167) — cloudscraper handles retries internally.
  - Update retry logic: if first attempt returns 403, log a warning but let cloudscraper's internal retry handle it. If cloudscraper itself returns 403 after its retries, then return 502.
- **Also update:** None (decrypt endpoint is standalone).
- **Verify:** `grep "_animeku_scraper.post" python/scraper_service.py` returns two matches (first attempt and fallback). `grep "_session.post.*animeku" python/scraper_service.py` returns zero matches.
- **Commit message:** `fix(scraper_service): use cloudscraper for animeku.org API to bypass CF`
- **Rollback:** `git revert HEAD`

**Step 2.4 — Simplify retry logic**
- **Files:** `python/scraper_service.py`
- **Change:** In `scrape_kuronime_decrypt()`:
  - Remove the `if resp.status_code == 403:` retry block entirely (lines 164-179).
  - Cloudscraper automatically retries CF challenges. If it returns 403, that means CF permanently blocked it.
  - Keep the status check at line 181: `if resp.status_code != 200:` and error handling.
- **Verify:** Function should have one cloudscraper POST call, one status check, no explicit retry loop. Grep `if resp.status_code == 403:` inside the decrypt function returns zero matches.
- **Commit message:** `refactor(scraper_service): remove explicit retry logic (cloudscraper auto-retries)`
- **Rollback:** `git revert HEAD`

### Phase 3: Test and verify

**Step 3.1 — Start Python service locally**
- **Files:** None
- **Change:** Run `cd python && python scraper_service.py` in background. Wait 3 seconds for startup.
- **Verify:** `curl -s http://localhost:5001/health` returns `{"status":"ok","service":"wibuflix-scraper-py"}`.
- **Commit message:** N/A (verification only)
- **Rollback:** N/A

**Step 3.2 — Test decrypt endpoint with mock token**
- **Files:** None
- **Change:** Run `curl -X POST http://localhost:5001/scrape/kuronime/decrypt -H "Content-Type: application/json" -d '{"token":"dXl1RHBYeXlpcW1GWEMzREZUUkh3cjRTeUN4QWpCa3c9PQ==","requestId":"test-123"}' -v` (use a recent valid token from logs if available, or any base64 string for structure test).
- **Verify:** Response is NOT `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...` (CF challenge page). Expected: either valid JSON response (200) or a different error (invalid token returns different error from animeku, not a CF page).
- **Commit message:** N/A (verification only)
- **Rollback:** N/A

**Step 3.3 — Verify server starts**
- **Files:** None
- **Change:** Kill Python service from 3.1. Run `node src/server.js` from repo root. Wait 5 seconds.
- **Verify:** Server logs show `🚀 WIBUFLIX BACKEND SERVER BERHASIL RESTART!` and no Python import errors. Port 5000 responds to `curl http://localhost:5000/`.
- **Commit message:** N/A (verification only)
- **Rollback:** N/A

**Step 3.4 — Push and deploy to Azure**
- **Files:** None
- **Change:** Run `git push origin main`. Wait for Azure deployment to complete (monitor via Azure Portal or `az webapp log tail`).
- **Verify:** Azure logs show `[ScraperService] Memulai Wibuflix Scraper Service di port 5001...` with no import errors. Trigger a Kuronime episode request from the app. Azure logs show `[Kuronime] [kr-XXX] Success: returning decrypted sources` instead of 403 errors.
- **Commit message:** N/A (push only, no new commit)
- **Rollback:** `git revert HEAD~4..HEAD && git push origin main --force-with-lease` (reverts Phase 2 commits)

## 5. Needs My Decision

None. All information needed to execute the plan is present.

## 6. Risks

### Phase 1
- **Risk:** cloudscraper version incompatibility with Python 3.14.
- **Mitigation:** Version 1.2.72 supports Python 3.6+. If install fails, try latest version without pin.
- **Detection:** `pip install` will fail with clear error.

### Phase 2
- **Risk:** cloudscraper auto-retry delays response time (cloudscraper retries CF challenges multiple times internally).
- **Mitigation:** Acceptable — better slow success than fast 403 failure. animeku.org timeout is 15s, cloudscraper will respect it.
- **Detection:** Monitor response times in Azure logs. If consistently >15s, may need to tune cloudscraper retry count.

- **Risk:** Removing `_session_lock` causes race condition if multiple decrypt requests arrive simultaneously.
- **Mitigation:** cloudscraper instances are thread-safe by default (uses requests.Session internally). Multiple calls can share `_animeku_scraper`.
- **Detection:** Concurrent decrypt requests would fail or return wrong data. Monitor error rate.

### Phase 3
- **Risk:** cloudscraper works locally but fails in Azure container (different IP reputation, region-specific CF rules).
- **Mitigation:** If Azure still gets 403, escalate to FlareSolverr or browser-based solution.
- **Detection:** Azure logs show `Animeku returned status 403` even with cloudscraper.

## 7. Noticed but Out of Scope

- Samehadaku also getting 403 after session reset (seen in logs). Not part of this plan; track separately.
- `fetch_html()` still uses curl_cffi. That's correct — cloudscraper only needed for animeku.org API, not HTML scraping.
- Python service runs Flask dev server (`WARNING: This is a development server`). Should use Gunicorn in production, but not blocking decrypt functionality.

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.
The senior model will run verify-plan, confirm correctness, then update the skill.
