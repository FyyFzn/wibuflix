# PLAN: Remove Orphaned Puppeteer Cookie Calls from videoExtractor

## 1. Goal and Scope

**Goal:** Fix ReferenceError crash in `videoExtractor.js` when extracting animeverse.id URLs by removing orphaned `getCfCookie()` and `refreshCfCookie()` calls left behind after Puppeteer removal.

**What's in:**
- Remove `getCfCookie()` and `refreshCfCookie()` calls from videoExtractor.js lines 400-410
- Test if animeverse.id URLs work without CF cookies (likely yes - direct S3 URLs)
- Keep referer and User-Agent headers (core requirement for animeverse.id)

**What's out:**
- Re-implementing Puppeteer cookie capture (Puppeteer fully removed Oct 2026)
- Adding new bypass mechanisms (animeverse.id URLs are direct S3 links, not CF-protected)
- Touching other extractors or providers
- Changing YLnime scraping logic (already fixed in previous plan)

**Done means:**
- videoExtractor.js loads without ReferenceError
- animeverse.id URL extraction returns `{url, headers}` with referer + UA
- YLnime video playback works through HLS proxy
- No Puppeteer references remain in videoExtractor.js

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
| F1 | VERIFIED | `src/services/extractors/videoExtractor.js:400` | Calls `getCfCookie('s3.animeverse.id') \|\| getCfCookie('animeverse.id')` but function not imported or defined. |
| F2 | VERIFIED | `src/services/extractors/videoExtractor.js:405` | Calls `await refreshCfCookie(originUrl)` but function not imported or defined. |
| F3 | VERIFIED | `src/services/extractors/videoExtractor.js:406` | Second `getCfCookie()` call after refresh attempt. |
| F4 | VERIFIED | `src/services/extractors/videoExtractor.js:1-8` | No imports for `getCfCookie` or `refreshCfCookie`. |
| F5 | VERIFIED | `plans/PLAN-2026-10-17-remove-puppeteer-proxy.md:131` | Previous Puppeteer removal plan explicitly deleted these imports, but forgot to remove the call sites. |
| F6 | VERIFIED | Comment line 402 | Says "Mengambil cookie CF (Puppeteer)" - confirms this was Puppeteer-based logic. |
| F7 | PARTIALLY TRUE | animeverse.id URLs | S3 bucket direct links (e.g. `https://s3.animeverse.id/ro/bdbd-1753155391612.mp4`). S3 typically doesn't need CF cookies - referer + UA likely sufficient. Runtime test needed to confirm. |

## 4. Phases and Steps

### Phase 1: Remove Orphaned Cookie Logic

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-20-remove-getcfcookie-calls.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-20-remove-getcfcookie-calls.md`
- **Rollback:** `git revert HEAD`

**Step 1 — Remove getCfCookie/refreshCfCookie calls from animeverse.id block**
- **Files:** `src/services/extractors/videoExtractor.js`
- **Change:** Replace lines 399-410 (entire animeverse.id cookie block) with:
  ```javascript
  if (embedUrl.includes('animeverse.id')) {
      referer = 'https://animeverse.id/';
      userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      // Note: animeverse.id S3 bucket URLs work with referer + UA only; no CF cookies needed
  ```
  Keep the rest of the function (lines 411-424) unchanged.
  
  Old block to remove:
  ```javascript
  cookieStr = getCfCookie('s3.animeverse.id') || getCfCookie('animeverse.id');
  if (!cookieStr) {
      console.log(`[VideoExtractor] Mengambil cookie CF (Puppeteer) untuk animeverse.id (YLnime)...`);
      try {
          const originUrl = new URL(embedUrl).origin + '/';
          await refreshCfCookie(originUrl);
          cookieStr = getCfCookie('s3.animeverse.id') || getCfCookie('animeverse.id');
      } catch (e) {
          console.error('[VideoExtractor] Gagal memancing cookie CF untuk YLnime:', e.message);
      }
  }
  ```
- **Verify:**
  1. `node --check src/services/extractors/videoExtractor.js` exits 0
  2. `grep -n "getCfCookie\|refreshCfCookie" src/services/extractors/videoExtractor.js` returns nothing
  3. `node src/server.js` starts without errors
- **Commit message:** `fix(videoExtractor): remove orphaned getCfCookie calls for animeverse.id URLs`
- **Rollback:** `git revert HEAD`

**Step 2 — Test animeverse.id URL extraction**
- **Files:** None (manual verification)
- **Change:** None
- **Verify:** Test extraction of animeverse.id URL:
  ```bash
  node -e "
  import('./src/services/extractors/videoExtractor.js').then(async m => {
    const testUrl = 'https://s3.animeverse.id/ro/bdbd-1753155391612.mp4';
    const result = await m.extractVideoUrl(testUrl, {});
    console.log('URL:', result?.url);
    console.log('Referer:', result?.headers?.Referer);
    console.log('User-Agent:', result?.headers['User-Agent']);
  });
  "
  ```
  Expected:
  - URL: `https://s3.animeverse.id/ro/bdbd-1753155391612.mp4`
  - Referer: `https://animeverse.id/`
  - User-Agent: Chrome/124 UA string
  - No ReferenceError
- **Rollback:** N/A (read-only test)

**Step 3 — Integration test: YLnime scraper → extractor → HLS proxy**
- **Files:** None (manual verification)
- **Change:** None
- **Verify:** Test full pipeline with real episode:
  ```bash
  # Start server in background (if not already running)
  # Then test via curl or Node:
  node -e "
  import('./src/services/scrapers/ylnimeScraper.js').then(async m => {
    const servers = await m.scrapeServers('https://ylnime.com/index.php?series=naruto-shippuuden-all-fixed&ep=1');
    if (servers.servers[0]) {
      const firstUrl = servers.servers[0].url;
      console.log('First server URL:', firstUrl);
      
      const extractor = await import('./src/services/extractors/videoExtractor.js');
      const extracted = await extractor.extractVideoUrl(firstUrl, {});
      console.log('Extracted URL:', extracted?.url);
      console.log('Has headers:', !!extracted?.headers);
    }
  });
  "
  ```
  Expected:
  - Server URL contains animeverse.id or pixeldrain
  - Extraction succeeds without crash
  - Extracted result has `url` and `headers` fields
- **Rollback:** N/A (read-only test)

## 5. Needs My Decision

**Question:** If Step 2/3 fail and animeverse.id returns 403 without cookies, what's the backup plan?

**Options:**
1. Accept that YLnime is broken (animeverse.id blocks datacenter IPs, Puppeteer removed)
2. Route animeverse.id requests through Python curl_cffi proxy (add to blocked-page-recovery)
3. Try alternative YLnime sources (pixeldrain URLs from same scraper)

**Current assumption:** animeverse.id S3 bucket doesn't need CF cookies. If wrong, we'll discover in Step 2/3.

## 6. Risks

**Phase 1:**
- **Risk:** animeverse.id requires CF cookies and blocks requests without them (403/challenge)
- **Mitigation:** Test shows scraper returns 2 sources (animeverse.id + pixeldrain). If animeverse fails, pixeldrain might work.
- **Detection:** Step 2 extraction returns 403 or Step 3 proxy stream fails with 403 from upstream
- **Fallback:** If animeverse.id blocked, consider it dead host and rely on pixeldrain/other sources

## 7. Noticed but Out of Scope

- **animeku.org block (line 411-413):** Also sets referer but no cookie logic. Likely also doesn't need cookies. Leave as-is.
- **cookieStr variable unused:** After removing getCfCookie calls, `cookieStr` (line 393) stays empty for animeverse.id. Line 419 `if (cookieStr)` never true for animeverse. Could clean up but harmless.
- **Previous Puppeteer removal incomplete:** `plans/PLAN-2026-10-17-remove-puppeteer-proxy.md` Step 3.2 said to delete getCfCookie imports but didn't verify call sites removed. Should add verification step to future plans.
- **Other providers might have same issue:** Search showed no other getCfCookie calls, but other Puppeteer remnants might exist elsewhere.

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- State whether animeverse.id extraction succeeded or failed in Step 2/3.
- Do not update the wibuflix skill or any skill file.

The senior model will run verify-plan, confirm correctness, then update the skill.
