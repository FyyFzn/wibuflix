# PLAN: Route Kuronime Decryptor API Call Through Python curl_cffi

## 1. Goal and Scope

**Problem:** The kuronime decryptor in `src/utils/kuronimeDecryptor.js` calls `https://animeku.org/api/v9/sources` directly via Axios. On Azure, Cloudflare blocks these requests with 403 because Axios has a detectable TLS fingerprint. The circuit breaker trips after 10 failures, and no mirror servers are ever returned.

**Solution:** Proxy the animeku.org POST request through the Python curl_cffi service (`localhost:5001`) which impersonates Chrome 124 TLS and bypasses Cloudflare.

**Done means:**
- The decryptor no longer calls animeku.org directly.
- A new Python endpoint `POST /scrape/kuronime/decrypt` proxies the request via curl_cffi.
- The Node decryptor calls this endpoint instead, receives the raw API response, and decrypts it as before.
- The existing decryption logic (`decryptKuronimeField`), `mirrorToServers()`, and the rest of the pipeline are untouched.
- Server starts cleanly on both Node and Python sides.

**Out of scope:**
- Changing the decryption algorithm or passphrase.
- Modifying `fetcher.py` (the new endpoint does its own POST, it doesn't fetch HTML).
- Changing any other scraper or extractor.
- Proxy (PROXY_URL) configuration.

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
| F1 | VERIFIED | `src/utils/kuronimeDecryptor.js:64-76` | First Axios POST to `animeku.org/api/v9/sources` with token. Gets 403 on Azure. |
| F2 | VERIFIED | `src/utils/kuronimeDecryptor.js:78-108` | Catch block: logs "Axios di-blokir oleh CDN (403)", checks circuit breaker, retries with same Axios (also fails). Returns null on failure. |
| F3 | VERIFIED | `src/utils/kuronimeDecryptor.js:6` | `KURONIME_PASSPHRASE` is a hardcoded constant used for decryption. Not relevant to the API call change. |
| F4 | VERIFIED | `src/utils/kuronimeDecryptor.js:1-4` | Imports: `crypto`, `axios`, `PROVIDER_URLS`. Axios is used only for the animeku.org call. |
| F5 | VERIFIED | `python/scraper_service.py:1-255` | Flask service with per-provider endpoints. Pattern: receive `{ "url": ... }`, call `fetch_html()`, parse, return JSON. |
| F6 | VERIFIED | `python/fetcher.py:25` | `_session = cf_requests.Session(impersonate="chrome124")` — the session that bypasses Cloudflare. |
| F7 | VERIFIED | `python/fetcher.py:47-78` | `fetch_html()` does GET only. The new endpoint needs a POST, so it must use `_session.post()` directly. |
| F8 | VERIFIED | `python/fetcher.py:26` | `_session_lock` is a threading.Lock that must be held when using `_session`. |
| F9 | VERIFIED | `src/config/providerUrls.js:66-70` | `ANIMEKU.BASE_URL` = `https://animeku.org`. |
| F10 | VERIFIED | `src/utils/kuronimeDecryptor.js:111-123` | After API response, decrypts `src`, `src_sd`, `mirror` fields. This logic stays unchanged. |

## 4. Phases and Steps

### Phase 1: Add Python endpoint

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-20-kuronime-decrypt-via-python.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-20-kuronime-decrypt-via-python.md`
- **Rollback:** `git revert HEAD`

**Step 1 — Add `POST /scrape/kuronime/decrypt` endpoint to Python service**
- **Files:** `python/scraper_service.py`
- **Change:** Add a new route function after the existing Kuronime routes (after line 133). The endpoint:
  - Route: `POST /scrape/kuronime/decrypt`
  - Accepts JSON body: `{ "token": "<base64 token string>" }`
  - Validates that `token` is present and non-empty (return 400 if missing).
  - Imports `_session`, `_session_lock` from `fetcher` (add `from fetcher import _session, _session_lock` at the top imports section near line 27).
  - Inside `_session_lock`, calls `_session.post("https://animeku.org/api/v9/sources", json={"id": token}, headers={"Content-Type": "application/json", "Referer": "https://kuronime.sbs/", "Origin": "https://kuronime.sbs"}, timeout=15)`.
  - On success: returns `jsonify(resp.json()), resp.status_code`.
  - On `curl_cffi` exception or non-2xx: logs the error, returns `jsonify({"error": str(e)}), 502`.
- **Also update:** Nothing else imports this route.
- **Verify:** Start the Python service (`python python/scraper_service.py`), then `curl -X POST http://localhost:5001/scrape/kuronime/decrypt -H "Content-Type: application/json" -d '{"token":"test"}' ` should return a response (likely `{"status":500,...}` from animeku for invalid token, but NOT a connection error or 403).
- **Commit message:** `feat(scraper_service): add /scrape/kuronime/decrypt endpoint via curl_cffi`
- **Rollback:** `git revert HEAD`

### Phase 2: Rewire Node decryptor

**Step 2 — Replace direct Axios call with Python service call in kuronimeDecryptor.js**
- **Files:** `src/utils/kuronimeDecryptor.js`
- **Change:**
  - Replace lines 62-108 (the entire `let apiResp; try { ... } catch { ... }` block) with a single try/catch that:
    - `const SCRAPER_BASE = \`http://localhost:\${process.env.SCRAPER_PORT || 5001}\`;`
    - POSTs to `${SCRAPER_BASE}/scrape/kuronime/decrypt` with body `{ token }` via Axios, timeout 20000.
    - Sets `apiResp = res.data;` on success.
    - On failure: logs `[KuronimeDecryptor] Python curl_cffi proxy gagal: ${err.message}` and returns `null`.
  - Remove the circuit breaker import and usage (lines 82-86, 102, 105) — no longer needed since curl_cffi handles TLS.
  - Keep the `PROVIDER_URLS` import (still used for the `Referer` header — actually no, the Python endpoint hardcodes the headers now, so `PROVIDER_URLS` is only used if something else in this file needs it). Check: `PROVIDER_URLS` is not used elsewhere in this file after the change. If so, remove the import on line 4. Keep the `DEFAULT_USER_AGENT` constant only if used elsewhere in the file — it is not, so remove it from line 2 as well. Keep `crypto` (used by `decryptKuronimeField`) and `axios` (used by the new call).
  - Do NOT touch: `decryptKuronimeField()` (lines 32-40), `mirrorToServers()` (lines 133-179), or the token extraction regex (lines 50-54).
- **Also update:** Nothing else imports `fetchKuronimeSourcesFromHtml` signature changes — it keeps the same `(html, page)` signature and return type.
- **Verify:** `node src/server.js` starts without errors. Then run a quick inline test:
  ```
  node -e "
    import('./src/utils/kuronimeDecryptor.js').then(m => {
      const html = 'var _0xa100d42aa = \"testtoken\"';
      m.fetchKuronimeSourcesFromHtml(html).then(r => console.log('Result:', r));
    });
  "
  ```
  Should log `[KuronimeDecryptor] Token ditemukan: testtoken` then either a decrypted result or `Python curl_cffi proxy gagal: ...` (depending on whether Python service is running). Must NOT log "Axios di-blokir oleh CDN" or reference circuit breaker.
- **Commit message:** `fix(kuronimeDecryptor): route animeku.org API through Python curl_cffi to bypass CF 403`
- **Rollback:** `git revert HEAD`

## 5. Needs My Decision

None. The approach is straightforward — one new endpoint, one rewired caller.

## 6. Risks

**Phase 1:**
- If `_session` or `_session_lock` are not importable from `fetcher` due to circular imports or naming: unlikely, they are module-level globals. Verify the import works in Step 1's verification.
- The Python service runs single-threaded (`threaded=False` in `scraper_service.py:253`). The animeku.org POST (up to 15s timeout) will block other requests. Acceptable given the existing architecture — all other scrape endpoints already block the same way.

**Phase 2:**
- If the Python service is down, the decryptor will fail with a connection error instead of a 403. Functionally equivalent — both return `null`. The log message changes from "CDN blocked" to "Python proxy gagal", which is more accurate.
- The `SCRAPER_BASE` URL is defined inline with `process.env.SCRAPER_PORT || 5001`. This matches the pattern used in every other scraper file (e.g., `samehadakuScraper.js:6`).

## 7. Noticed but Out of Scope

- The `page` parameter in `fetchKuronimeSourcesFromHtml(html, page)` is vestigial (Puppeteer removed Oct 2026). Could be cleaned up separately.
- The circuit breaker for `animeku.org` will no longer be exercised by any code path after this change. The breaker instance itself remains in `circuitBreaker.js` but is harmless.
- `DEFAULT_USER_AGENT` constant becomes unused after the change. Removed as part of the cleanup.

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.
The senior model will run verify-plan, confirm correctness, then update the skill.
