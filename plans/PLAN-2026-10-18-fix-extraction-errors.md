# PLAN: Fix Video Extraction and Scraper Errors

## 1. Goal and Scope

**Goal:** Fix 8 code-level bugs blocking video extraction and scraping identified from production logs.

**Done means:**
- No `globalUserAgent is not defined` errors in logs
- Nimegami Python parser returns episode data (not empty)
- Dead video hosts (ZippyShare, Solidfiles, Racaty, linkbox) filtered before extraction
- Kuronime circuit breaker doesn't open (or decryption bypasses it)
- AI error summaries send to Telegram without entity parse errors
- Acefile extractor doesn't reference removed Puppeteer WebView
- Wibufile AJAX servers resolve successfully
- Fairy Tail Episode 1 plays (currently fails after 5 retries)
- Server starts without errors

**In scope:**
- Fix videoExtractor.js line 388 `globalUserAgent` reference
- Update Nimegami Python parser selectors in python/parsers/nimegami.py
- Add dead host filter to videoExtractor.js
- Fix Telegram entity escaping in AIMonitor
- Remove Acefile WebView fallback code
- Update Wibufile data-post selector
- Increase Kuronime circuit breaker threshold (optional)
- Update Neosatsu Zenkaiger label (optional)

**Out of scope:**
- Samehadaku 500 errors (external server issue)
- Acefile 404 for specific files (dead provider links)
- VidHide anti-hotlink blocks (intentional external blocking)
- Migration of Otakudesu/Neosatsu/Nanime latest scrapers to Python (working fine, no CF issues)

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
| F1 | VERIFIED | src/services/extractors/videoExtractor.js:388 | `globalUserAgent` variable referenced but not defined after Puppeteer removal |
| F2 | VERIFIED | logs line 29,39,45 | Nimegami Python scraper returns empty data for fairy-tail-sub-indo |
| F3 | VERIFIED | logs line 35-55 | Dead hosts (ZippyShare, Solidfiles, Racaty, linkbox) have no extractors but scrapers return them |
| F4 | VERIFIED | logs line 40-55 | Kuronime decryptor gets 403 from animeku.org, circuit breaker opens after 5 failures |
| F5 | VERIFIED | logs line 51 | AIMonitor Telegram send fails: "can't parse entities: Can't find end of the entity starting at byte offset 410" |
| F6 | VERIFIED | logs line 56 | Acefile extractor logs "fallback ke WebView" after 404 (Puppeteer removed, WebView doesn't exist) |
| F7 | PARTIALLY TRUE | logs line 55 | Wibufile AJAX resolve fails: "Tidak menemukan ID Post (data-post) setelah fallback" |
| F8 | VERIFIED | logs line 22-28 | Neosatsu returns 0 episodes for "Mashin Sentai Zenkaiger" (label may have changed) |
| F9 | VERIFIED | Latest scrapers | 5/8 providers use Python (Kuronime, Oploverz, Nimegami, YLnime, Samehadaku); 3/8 use Node.js (Otakudesu, Neosatsu, Nanime) |

## 4. Phases and Steps

### Phase 1: Critical Extraction Fixes (blocks video playback)

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-18-fix-extraction-errors.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-18-fix-extraction-errors.md`
- **Rollback:** `git revert HEAD`

**Step 1.1 — Fix globalUserAgent reference**
- **Files:** `src/services/extractors/videoExtractor.js`
- **Change:** 
  - Line 388: Replace `userAgent = globalUserAgent;` with `userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';`
  - Line 1-10: Remove any imports containing `globalUserAgent` (likely from deleted puppeteer/pool.js)
- **Also update:** None (local variable only)
- **Verify:** 
  1. `grep -n "globalUserAgent" src/services/extractors/videoExtractor.js` returns no matches
  2. `node server-prod.js` — server starts without errors
  3. Check logs for YLnime extraction — should not see "globalUserAgent is not defined"
- **Commit message:** `fix(videoExtractor): replace deleted globalUserAgent with hardcoded UA`
- **Rollback:** `git revert HEAD`

**Step 1.2 — Add dead host filter**
- **Files:** `src/services/extractors/videoExtractor.js`
- **Change:** 
  - Find the main extraction loop (where `[Unsupported]` logs appear)
  - Before the loop or at the start of each iteration, add:
    ```js
    const DEAD_HOSTS = ['zippyshare.com', 'solidfiles.com', 'racaty.net', 'lbx.to'];
    const isDeadHost = (url) => DEAD_HOSTS.some(h => url.includes(h));
    ```
  - In the loop, before attempting extraction:
    ```js
    if (isDeadHost(embedUrl)) {
        console.log(`[Dead Host] ${embedUrl} — Dilewati.`);
        continue;
    }
    ```
- **Also update:** None
- **Verify:**
  1. `node server-prod.js` — server starts
  2. Trigger Fairy Tail Ep 1 extraction (or check logs)
  3. Dead host URLs should log `[Dead Host]` instead of `[Unsupported] Tidak ada extractor`
- **Commit message:** `feat(videoExtractor): filter dead hosts before extraction attempt`
- **Rollback:** `git revert HEAD`

**Step 1.3 — Remove Acefile WebView fallback**
- **Files:** `src/services/extractors/providers/acefile.js` (if it exists as separate file) OR find Acefile logic in videoExtractor.js
- **Change:**
  - Find the line logging "fallback ke WebView" (search: `grep -rn "fallback ke WebView" src/`)
  - Remove the entire WebView fallback block
  - Replace with: `throw new Error('[Acefile] File not found (404)');`
- **Also update:** None
- **Verify:**
  1. `grep -rn "WebView\|webview" src/services/extractors/` returns no matches in acefile code
  2. `node server-prod.js` — server starts
- **Commit message:** `fix(acefile): remove Puppeteer WebView fallback after 404`
- **Rollback:** `git revert HEAD`

### Phase 2: Notification and UI Fixes

**Step 2.1 — Fix Telegram entity escaping**
- **Files:** Search for AIMonitor or Telegram send logic: `grep -rn "sendMessage\|Telegram" src/jobs/`
- **Change:**
  - Find where error message is sent to Telegram
  - Before the `bot.sendMessage()` or equivalent call, add:
    ```js
    // Escape MarkdownV2 special characters
    const escaped = errorText.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
    ```
  - Use `escaped` instead of raw `errorText` in the send call
  - OR: Add `{ parse_mode: null }` to the options to disable Markdown parsing entirely
- **Also update:** None
- **Verify:**
  1. `node server-prod.js` — server starts
  2. Trigger an error (or wait for natural errors in logs)
  3. Check Telegram — error notification should arrive without "can't parse entities" error
- **Commit message:** `fix(telegram): escape MarkdownV2 entities in AIMonitor notifications`
- **Rollback:** `git revert HEAD`

### Phase 3: Python Scraper Repairs (optional, requires investigation)

**Step 3.1 — Inspect Nimegami HTML structure**
- **Files:** None (manual inspection)
- **Change:** 
  1. `curl -A "Mozilla/5.0" https://nimegami.id/fairy-tail-sub-indo/ > /tmp/nimegami.html`
  2. `grep -o "streaming_eps_box\|list_eps_stream\|select-eps" /tmp/nimegami.html`
  3. Open `/tmp/nimegami.html` in editor, find episode list structure
  4. Document current CSS selectors used vs actual HTML structure
- **Verify:** You have identified whether selectors are outdated
- **Commit message:** N/A (investigation only)
- **Rollback:** N/A

**Step 3.2 — Update Nimegami Python parser selectors**
- **Files:** `python/parsers/nimegami.py`
- **Change:** Based on Step 3.1 findings, update CSS selectors to match current HTML
- **Also update:** None
- **Verify:**
  1. Test parser locally:
     ```bash
     cd python
     python -c "from parsers.nimegami import parse_series; from fetcher import fetch_html; print(parse_series(fetch_html('https://nimegami.id/fairy-tail-sub-indo/'), 'https://nimegami.id/fairy-tail-sub-indo/'))"
     ```
  2. Should return non-empty episode list
  3. Restart server, check Nimegami scraper logs — should return data
- **Commit message:** `fix(nimegami): update Python parser selectors for episode list`
- **Rollback:** `git revert HEAD`

**Step 3.3 — Update Wibufile data-post selector (optional)**
- **Files:** Search for Wibufile AJAX resolution logic in Kuronime scraper
- **Change:**
  1. Fetch a live Kuronime episode page with Wibufile server
  2. Inspect HTML for `data-post` attribute location
  3. Update selector in the AJAX resolve function
- **Also update:** None
- **Verify:** 
  1. `node server-prod.js` — server starts
  2. Test Wibufile extraction from Kuronime episode
  3. Should not log "Tidak menemukan ID Post (data-post)"
- **Commit message:** `fix(wibufile): update data-post selector for AJAX server resolution`
- **Rollback:** `git revert HEAD`

### Phase 4: Circuit Breaker Tuning (optional)

**Step 4.1 — Increase Kuronime circuit breaker threshold**
- **Files:** `src/utils/kuronimeDecryptor.js` OR `src/utils/circuitBreaker.js`
- **Change:** Find circuit breaker configuration for animeku.org, increase failure threshold from 5 to 10
- **Also update:** None
- **Verify:**
  1. `node server-prod.js` — server starts
  2. Monitor logs — circuit breaker should take longer to open
- **Commit message:** `refactor(kuronime): increase circuit breaker threshold to 10 failures`
- **Rollback:** `git revert HEAD`

## 5. Needs My Decision

1. **Nimegami parser fix:** Requires live HTML inspection to determine correct selectors. Step 3.1 investigation may reveal site is down or restructured entirely.
2. **Wibufile data-post fix:** May not be fixable if Kuronime changed their AJAX system entirely. Alternative: disable Wibufile servers.
3. **Circuit breaker strategy:** Increasing threshold is a band-aid. Better long-term: bypass decryption, return encrypted URLs to client, or implement Python CF bypass.
4. **Neosatsu Zenkaiger:** May require manual feed inspection. Label might be renamed or series removed from Neosatsu entirely.

## 6. Risks

**Phase 1:**
- Hardcoded User-Agent may not work for all YLnime sources (but better than crash)
- Dead host filter may block hosts that are temporarily down but will recover

**Phase 2:**
- Escaping all Telegram entities may break intentional formatting (prefer `parse_mode: null`)

**Phase 3:**
- Nimegami site structure may have changed so drastically that parser needs full rewrite
- Wibufile may be permanently broken if Kuronime removed that host

**Phase 4:**
- Higher circuit breaker threshold delays protection but allows more retry attempts

## 7. Noticed but Out of Scope

- Samehadaku 500 error (external server issue, not fixable from our side)
- VidHide anti-hotlink blocks (intentional, would require full headless browser)
- Migration of Otakudesu/Neosatsu/Nanime latest scrapers to Python (working fine, no CF issues, no urgency)
- YLnime direct URL extraction sometimes returns globalUserAgent error (fixed in Phase 1)

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.

The senior model will run verify-plan, confirm correctness, then update the skill.
