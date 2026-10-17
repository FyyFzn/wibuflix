# PLAN: Remove Proxy Dependency and Puppeteer Infrastructure

## 1. Goal and Scope

**Goal:** Remove broken proxy configuration and unused Puppeteer infrastructure from backend after migration to Python curl_cffi scrapers.

**Done means:**
- PROXY_URL env var removed from Azure App Service (proxy fails with 407 due to IP whitelist)
- All Puppeteer imports removed from codebase
- Puppeteer pool initialization/cleanup removed from server.js
- src/puppeteer/ directory deleted
- puppeteer, puppeteer-extra, puppeteer-extra-plugin-stealth removed from package.json
- Chromium and X11/DRI dependencies removed from Dockerfile
- Server starts successfully without Puppeteer
- Image size reduced by ~200MB
- Deployed to Azure and verified scrapers still work

**In scope:**
- Remove PROXY_URL from Azure env
- Remove getAxiosProxyConfig() from scrapeHelper.js (only used for PROXY_URL)
- Remove fetchWithCF() from scrapeHelper.js (replaced by Python scrapers)
- Remove all imports from src/puppeteer/pool.js across 15 files
- Remove initPagePool/closeAllBrowsers calls from server.js
- Delete entire src/puppeteer/ directory (5 files: browserPool.js, pool.js, circuitBreaker.js, concurrencyGuard.js, cookieSessionStore.js)
- Remove Puppeteer npm dependencies
- Remove Chromium install from Dockerfile (lines 10-52)
- Verify otakudesu-scraper and Python scrapers still work

**Out of scope:**
- Changes to Python scraper service (already migrated, working)
- Changes to otakudesu-scraper dependency (native implementation, no Puppeteer)
- Video extractor iframe resolution (if needed, will use Python curl_cffi)
- Any new scraper features

## 2. Executor Rules

- Follow phases and steps in order, one at a time.
- Commit after each step: `git add -A && git commit -m "<type>(<scope>): <step description>"`
- If the code does not match what a step describes, STOP and report the mismatch. Do not improvise or fix adjacent things.
- Do not add dependencies, rename things, or change behavior outside the step.
- Run the step's verification before moving on. If it fails, stop and report.
- For backend steps: verify server starts with `node server-prod.js` (waits for "WIBUFLIX BACKEND SERVER BERHASIL RESTART" log) before committing.
- For frontend steps: verify types compile with `npx tsc --noEmit` before committing.
- Do NOT update any skill file. Skill updates are handled by the senior model after verification.

## 3. Findings

| ID | Status | File:Line | Description |
|----|--------|-----------|-------------|
| F1 | VERIFIED | Azure env | PROXY_URL=http://insnurgp:ae9zpekzenrp@142.111.67.146:5611 fails with 407 (IP not whitelisted) |
| F2 | VERIFIED | python/fetcher.py:30-31 | Python fetcher reads PROXY_URL, gracefully degrades if absent |
| F3 | VERIFIED | src/utils/scrapeHelper.js:8,118-121 | Node scrapeHelper reads PROXY_URL via getAxiosProxyConfig() |
| F4 | VERIFIED | logs line 9-12 | Samehadaku getting 403 from Python scraper after proxy added |
| F5 | VERIFIED | logs line 18 | Puppeteer pool still initializes ("Pool browser berhasil diinisialisasi") |
| F6 | VERIFIED | src/server.js:20,60 | initPagePool() called at startup, closeAllBrowsers() in gracefulShutdown |
| F7 | VERIFIED | 15 files | Import from src/puppeteer/pool.js: scrapers (kuronime, nimegami, oploverz, otakudesu, nanime), extractors (videoExtractor, generic, blogger), sync (anime_sync, nimegami_sync, oploverz_sync), utils (scrapeHelper, kuronimeDecryptor), controllers (hotController), scripts (check_provider_accessibility) |
| F8 | VERIFIED | package.json:34-36 | puppeteer, puppeteer-extra, puppeteer-extra-plugin-stealth in dependencies |
| F9 | VERIFIED | Dockerfile:10-52 | Chromium + X11/DRI/Mesa dependencies (43 packages) |
| F10 | VERIFIED | src/services/extractors/videoExtractor.js:12-70 | resolveServerIframe() uses Puppeteer page.evaluate for AJAX calls |
| F11 | VERIFIED | src/utils/scrapeHelper.js:86-232 | fetchWithCF() is main Puppeteer wrapper, used by 16 files |
| F12 | VERIFIED | Samehadaku/Kuronime/YLnime/Oploverz/Nimegami | All migrated to Python curl_cffi, no longer call fetchWithCF |
| F13 | PARTIALLY TRUE | Otakudesu | Uses otakudesu-scraper npm package (native HTTP), not Puppeteer |
| F14 | UNVERIFIABLE | Video iframe extraction | May still need Puppeteer for page.evaluate AJAX calls; investigate runtime usage before removing |

## 4. Phases and Steps

### Phase 1: Remove Proxy Configuration (immediate production fix)

**Step 1.0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-17-remove-puppeteer-proxy.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-17-remove-puppeteer-proxy.md`
- **Rollback:** `git revert HEAD`

**Step 1.1 — Remove PROXY_URL from Azure App Service**
- **Files:** Azure Portal → wibuflix App Service → Configuration → Application settings
- **Change:** Delete PROXY_URL setting, click Save (triggers container restart)
- **Verify:** 
  1. Azure Portal shows PROXY_URL no longer in Application settings
  2. Wait for container restart (check Deployment Center logs or App Service Logs)
  3. Check latest sync logs — samehadaku/kuronime should return 200 or still 403 (CF challenge), not 407
- **Rollback:** Re-add PROXY_URL in Azure Portal Application settings with original value
- **Commit message:** N/A (Azure config change, not code)

**Step 1.2 — Remove getAxiosProxyConfig from scrapeHelper.js**
- **Files:** `src/utils/scrapeHelper.js`
- **Change:** 
  - Delete function `getAxiosProxyConfig()` (lines 7-18)
  - Delete lines 118-121 (proxy config merge in fetchWithCF)
- **Also update:** None (function only called within same file)
- **Verify:** 
  1. `grep -n "getAxiosProxyConfig\|PROXY_URL" src/utils/scrapeHelper.js` returns no matches
  2. `node server-prod.js` — server starts without errors
- **Commit message:** `refactor(scrapeHelper): remove getAxiosProxyConfig after proxy removal`
- **Rollback:** `git revert HEAD`

### Phase 2: Investigate Puppeteer Runtime Usage

**Step 2.1 — Check video extractor iframe usage**
- **Files:** `src/services/extractors/videoExtractor.js`
- **Change:** Add temporary debug logging to resolveServerIframe() entry point (line 12):
  ```javascript
  async function resolveServerIframe(page, { post, nume, type, episodeUrl }, req) {
      console.log(`[DEBUG] resolveServerIframe called: post=${post} nume=${nume} type=${type} url=${episodeUrl}`);
      try {
  ```
- **Also update:** None
- **Verify:** 
  1. `grep -n "DEBUG.*resolveServerIframe" src/services/extractors/videoExtractor.js` shows the log line
  2. `node server-prod.js` — server starts
- **Commit message:** `debug(videoExtractor): add temp logging to track iframe resolver usage`
- **Rollback:** `git revert HEAD`

**Step 2.2 — Monitor production for 24 hours**
- **Files:** Azure App Service Logs
- **Change:** Deploy current code to Azure, monitor logs for "[DEBUG] resolveServerIframe" occurrences
- **Verify:** 
  1. Check App Service logs for 24 hours
  2. If zero hits: Puppeteer iframe resolver is dead code, safe to remove
  3. If hits found: Note which provider/episode triggered it — will need Python equivalent
- **Commit message:** N/A (observation only)
- **Rollback:** N/A

### Phase 3: Remove Puppeteer Code

**Step 3.1 — Remove fetchWithCF from scrapeHelper.js**
- **Files:** `src/utils/scrapeHelper.js`
- **Change:** 
  - Delete entire `fetchWithCF()` function (lines 86-232)
  - Delete imports: `acquireFromPool, releaseToPool, getCfCookie, getCfCookiesArray, globalUserAgent, refreshCfCookie, waitForCloudflare` from line 1
  - Delete `injectCFCookies()` function (lines 44-71)
  - Delete `isCloudflareHtml()` function (lines 26-38)
  - Delete `ORIGIN_DOWN_STATUS_CODES` constant (line 78)
  - Keep only: `circuitBreaker` import and exports
- **Also update:** 
  - `src/services/scrapers/kuronimeScraper.js`: Remove `fetchWithCF` import (line 3), remove usage (lines 64, 77)
  - `src/services/scrapers/nimegamiScraper.js`: Remove `fetchWithCF` import, remove usage
  - `src/services/scrapers/oploverzScraper.js`: Remove `fetchWithCF` import, remove usage
  - `src/services/scrapers/otakudesuScraper.js`: Remove `fetchWithCF` import, remove usage
  - `src/services/scrapers/nanimeScraper.js`: Remove `fetchWithCF` import, remove usage (provider disabled, but clean up anyway)
  - `src/services/scrapers/ylnimeScraper.js`: Check if used (likely not, already Python)
  - All above: If scraper was calling `fetchWithCF`, verify it's now calling Python scraper service instead
- **Verify:** 
  1. `grep -rn "fetchWithCF" src/` returns no matches
  2. `node server-prod.js` — server starts
  3. Manual test: `curl http://localhost:3000/api/anime/samehadaku/<slug>` returns episode list
- **Commit message:** `refactor(scrapeHelper): remove fetchWithCF after Python migration`
- **Rollback:** `git revert HEAD`

**Step 3.2 — Remove Puppeteer imports from scrapers**
- **Files:** 
  - `src/services/scrapers/kuronimeScraper.js`
  - `src/services/scrapers/nimegamiScraper.js`
  - `src/services/scrapers/oploverzScraper.js`
  - `src/services/scrapers/otakudesuScraper.js`
  - `src/services/scrapers/ylnimeScraper.js`
  - `src/services/scrapers/nanimeScraper.js`
- **Change:** Remove `import { ... } from '../../puppeteer/pool.js'` and any `releaseToPool(slot)` calls
- **Also update:** None (scrapers are leaves, nothing imports them)
- **Verify:** 
  1. `grep -rn "puppeteer/pool" src/services/scrapers/` returns no matches
  2. `node server-prod.js` — server starts
- **Commit message:** `refactor(scrapers): remove unused puppeteer imports`
- **Rollback:** `git revert HEAD`

**Step 3.3 — Remove Puppeteer imports from extractors and utils**
- **Files:** 
  - `src/services/extractors/videoExtractor.js`
  - `src/services/extractors/providers/generic.js`
  - `src/services/extractors/providers/blogger.js`
  - `src/utils/kuronimeDecryptor.js`
- **Change:** 
  - Remove all `import { ... } from '...puppeteer/pool.js'`
  - If `resolveServerIframe()` in videoExtractor.js was unused (Step 2.2 showed zero hits), delete the entire function
  - If it was used, replace page.evaluate with Python curl_cffi equivalent (stop and report — out of initial scope)
- **Also update:** Check if resolveServerIframe is exported and used elsewhere
- **Verify:** 
  1. `grep -rn "puppeteer/pool" src/services/extractors/ src/utils/` returns no matches
  2. `node server-prod.js` — server starts
- **Commit message:** `refactor(extractors,utils): remove puppeteer imports`
- **Rollback:** `git revert HEAD`

**Step 3.4 — Remove Puppeteer imports from sync workers**
- **Files:** 
  - `src/sync/anime_sync.js`
  - `src/sync/nimegami_sync.js`
  - `src/sync/oploverz_sync.js`
- **Change:** Remove `import { ... } from '../puppeteer/pool.js'` lines
- **Also update:** None
- **Verify:** 
  1. `grep -rn "puppeteer/pool" src/sync/` returns no matches
  2. `node server-prod.js` — server starts
- **Commit message:** `refactor(sync): remove puppeteer imports from sync workers`
- **Rollback:** `git revert HEAD`

**Step 3.5 — Remove Puppeteer imports from controllers and scripts**
- **Files:** 
  - `src/controllers/hotController.js`
  - `src/scripts/check_provider_accessibility.js`
- **Change:** Remove `import { ... } from '../puppeteer/pool.js'` lines
- **Also update:** None
- **Verify:** 
  1. `grep -rn "puppeteer/pool" src/` returns no matches (entire src/)
  2. `node server-prod.js` — server starts
- **Commit message:** `refactor(controllers,scripts): remove puppeteer imports`
- **Rollback:** `git revert HEAD`

**Step 3.6 — Remove pool initialization from server.js**
- **Files:** `src/server.js`
- **Change:** 
  - Delete `import { initPagePool, closeAllBrowsers } from './puppeteer/pool.js';` (line 20)
  - Delete `await initPagePool();` call (around line 102-120, background init section)
  - Delete `await closeAllBrowsers();` from gracefulShutdown (line 60)
  - Remove TargetCloseError handler (lines 11-14, now unused)
- **Also update:** None
- **Verify:** 
  1. `grep -n "puppeteer\|initPagePool\|closeAllBrowsers\|TargetCloseError" src/server.js` returns no matches
  2. `node server-prod.js` — server starts, no Puppeteer init message in logs
  3. Logs should NOT show "Pool browser berhasil diinisialisasi"
- **Commit message:** `refactor(server): remove puppeteer pool initialization`
- **Rollback:** `git revert HEAD`

**Step 3.7 — Delete puppeteer directory**
- **Files:** `src/puppeteer/` (entire directory)
- **Change:** Delete directory and all 5 files inside
- **Also update:** None (all imports already removed in previous steps)
- **Verify:** 
  1. `ls src/puppeteer` returns "No such file or directory"
  2. `grep -rn "puppeteer" src/` returns no matches (except comments)
  3. `node server-prod.js` — server starts
- **Commit message:** `refactor: delete unused puppeteer directory`
- **Rollback:** `git revert HEAD` (restores directory)

### Phase 4: Remove Dependencies

**Step 4.1 — Remove Puppeteer npm packages**
- **Files:** `package.json`
- **Change:** Remove lines 34-36:
  ```
  "puppeteer": "^25.2.1",
  "puppeteer-extra": "^3.3.6",
  "puppeteer-extra-plugin-stealth": "^2.11.2",
  ```
- **Also update:** Run `npm install` to update package-lock.json
- **Verify:** 
  1. `grep -n "puppeteer" package.json` returns no matches
  2. `npm install` completes without errors
  3. `node server-prod.js` — server starts
- **Commit message:** `chore(deps): remove puppeteer packages`
- **Rollback:** `git revert HEAD`, then `npm install`

**Step 4.2 — Remove Chromium from Dockerfile**
- **Files:** `Dockerfile`
- **Change:** 
  - Line 2 comment: Change "Node.js + Puppeteer (Chromium) + Python scraper service" to "Node.js + Python scraper service"
  - Delete lines 10-52 (entire Chromium dependencies block, from "# Install Chromium dependencies" comment through the rm command)
  - Delete lines 54-55 (Chromium CfT comments)
  - Keep Python, ca-certificates, wget, unzip, tar, bzip2, xz-utils (needed for Python curl_cffi and general ops)
- **Also update:** None
- **Verify:** 
  1. `grep -n "chromium\|Puppeteer\|X11\|DRI\|Mesa" Dockerfile` returns no matches (case insensitive)
  2. Build image locally: `docker build -t wibuflix-test .` — succeeds, image size reduced
  3. Check image size: `docker images wibuflix-test` — should be ~200MB smaller
- **Commit message:** `chore(docker): remove Chromium dependencies after Puppeteer removal`
- **Rollback:** `git revert HEAD`

### Phase 5: Deploy and Verify

**Step 5.1 — Push to GitHub**
- **Files:** N/A
- **Change:** `git push origin main`
- **Verify:** GitHub Actions workflow triggers (if configured), or Azure auto-deploys from ACR
- **Commit message:** N/A
- **Rollback:** `git revert HEAD~7..HEAD` (reverts last 7 commits from Phase 3-4), then force push

**Step 5.2 — Deploy to Azure and monitor**
- **Files:** Azure App Service
- **Change:** Wait for Azure to pull and deploy new image from ACR
- **Verify:** 
  1. Azure Deployment Center shows successful deployment
  2. App Service Logs show "WIBUFLIX BACKEND SERVER BERHASIL RESTART" without Puppeteer init message
  3. Logs do NOT show "Pool browser berhasil diinisialisasi"
  4. Latest sync runs successfully for all providers (check [Latest Sync] logs)
  5. Manual API test: `curl https://wibuflix.azurewebsites.net/api/anime/samehadaku/<slug>` returns episode list
  6. Python scraper 403 on Samehadaku is CF challenge (expected), NOT 407 proxy auth
- **Commit message:** N/A (deployment verification)
- **Rollback:** Azure Portal → Deployment Center → Redeploy previous version

**Step 5.3 — Remove debug logging from videoExtractor**
- **Files:** `src/services/extractors/videoExtractor.js`
- **Change:** Remove the debug log line added in Step 2.1
- **Verify:** 
  1. `grep -n "DEBUG.*resolveServerIframe" src/services/extractors/videoExtractor.js` returns no matches
  2. `node server-prod.js` — server starts
- **Commit message:** `chore(videoExtractor): remove debug logging`
- **Rollback:** `git revert HEAD`

## 5. Needs My Decision

1. **resolveServerIframe usage:** Step 2.2 monitors for 24 hours. If it's actively used:
   - Option A: Keep minimal Puppeteer just for iframe AJAX resolution
   - Option B: Rewrite iframe resolution in Python curl_cffi with requests
   - Option C: Drop iframe resolution, let those streams fail gracefully
   - **Decision needed before Step 3.3**

2. **Samehadaku 403 handling:** After proxy removal, Samehadaku may still return 403 (Cloudflare challenge). Python curl_cffi should bypass most CF challenges with Chrome 124 TLS fingerprint, but if persistent:
   - Option A: Accept occasional 403 failures, rely on other providers
   - Option B: Investigate CF bypass enhancements in curl_cffi
   - Option C: Use residential proxy service with proper IP whitelist
   - **No blocker — can decide post-deployment based on failure rate**

3. **Deployment timing:** Phase 1 (proxy removal) is immediate fix. Phase 3-4 (Puppeteer removal) is cleanup with minor risk (resolveServerIframe usage unknown). 
   - Option A: Deploy Phase 1 now, Phase 3-4 after monitoring
   - Option B: Deploy all phases together after Step 2.2 monitoring completes
   - **Recommend Option A: fix proxy 407 immediately, defer Puppeteer cleanup**

## 6. Risks

### Phase 1: Proxy Removal
- **Risk:** Samehadaku/Kuronime may still fail with 403 after proxy removed
- **Mitigation:** Python curl_cffi already working for most providers; 403 is CF challenge, not auth failure
- **Detection:** [Latest Sync] logs show 403 or 500 for affected providers

### Phase 2: Usage Monitoring
- **Risk:** 24-hour window may miss infrequent iframe resolver calls
- **Mitigation:** Check historical logs for resolveServerIframe patterns before monitoring
- **Detection:** Step 2.2 observation period

### Phase 3: Puppeteer Code Removal
- **Risk:** resolveServerIframe may be actively used, breaking video extraction for some providers
- **Mitigation:** Step 2.2 monitoring identifies usage before removal; can implement Python equivalent
- **Detection:** Video extraction fails, returns empty servers list, or 500 errors on /api/extract endpoints

### Phase 4: Dependency Removal
- **Risk:** Docker build fails due to missing dependencies used by other components
- **Mitigation:** Python curl_cffi and core system packages retained; only Chromium/X11/DRI removed
- **Detection:** `docker build` fails with missing package errors

### Phase 5: Deployment
- **Risk:** Production regression if Puppeteer was still handling edge cases
- **Mitigation:** Full logs review before proceeding; can rollback to previous deployment
- **Detection:** Spike in 500 errors, scraper failures, or user reports

## 7. Noticed but Out of Scope

- **Samehadaku 403 long-term fix:** May need residential proxy or advanced CF bypass — leave for future optimization
- **https-proxy-agent dependency:** Still in package.json (line 28) but only used by removed proxy code — clean in separate pass
- **Circuit breaker in scrapeHelper.js:** Remains but may be orphaned after fetchWithCF removal — audit separately
- **otakudesu-scraper dependency:** Native HTTP implementation, no Puppeteer, working fine
- **Video extractor refactor:** If iframe resolver is used, Python rewrite is separate task
- **Memory/CPU optimization verification:** Expect savings from Chromium removal, but formal benchmarking is separate effort

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Report Step 2.2 findings: was resolveServerIframe ever called during monitoring?
- Report Samehadaku/Kuronime scraper status: 200 OK, 403 CF challenge, or other error?
- Do not update the wibuflix skill or any skill file.

The senior model will run verify-plan, confirm correctness, then update the skill.
