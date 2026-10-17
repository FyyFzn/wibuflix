# PLAN: Backend Code Quality & Performance Improvements (Findings 1–8)

## 1. Goal and Scope

Resolve 8 backend findings from the code audit. In scope:
- src/utils/cacheManager.js
- src/utils/stringUtils.js
- src/services/animeOrchestrator.js
- src/services/episodeService.js
- src/sync/unified_sync.js
- src/jobs/scheduler.js
- src/sync/latest_sync.js
- python/fetcher.py

Out of scope: frontend files, scraper logic, extractor providers, Azure pipeline, route/controller files.
"Done" means all 8 steps committed, server starts cleanly, and no regressions in the affected files.

---

## 2. Executor Rules

- Follow phases and steps in order, one at a time.
- Commit after each step: `git add -A && git commit -m "<type>(<scope>): <step description>"`.
- If the code does not match what a step describes, STOP and report the mismatch. Do not improvise or fix adjacent things.
- Do not add dependencies, rename things, or change behavior outside the step.
- Run the step's verification before moving on. If it fails, stop and report.
- For backend steps: verify server starts with `node src/server.js` before committing.

---

## 3. Findings

| ID | Status | File:Line | Description |
|----|--------|-----------|-------------|
| F1 | VERIFIED | src/services/animeOrchestrator.js:8–55 | Hand-rolled LRUMemoryCache class duplicates NodeCache already in cacheManager.js |
| F2 | VERIFIED | src/services/episodeService.js:17–22, src/services/animeOrchestrator.js:97–99 | OVA regexes defined in episodeService.js, then inlined again verbatim in animeOrchestrator.js |
| F3 | VERIFIED | src/services/episodeService.js:1–555 | 555-line file handles OVA detection, deduplication, DB lookup, auto-migration, scrape orchestration, episode merging, DB write-back, and MAL assembly — 6+ concerns |
| F4 | VERIFIED | src/services/episodeService.js:118–133 | LEGACY_DB_FALLBACK branch builds unindexed $or query across all provider schema paths on every cache miss |
| F5 | VERIFIED | src/services/episodeService.js:136–155 | findAnimeInDatabase() calls dbAnime.save() — a write inside a read function, causing VersionError races |
| F6 | VERIFIED | src/sync/unified_sync.js:29–109 | 50 sequential await anime.save() calls inside a for loop; latest_sync.js already uses bulkWrite correctly |
| F7 | VERIFIED | python/fetcher.py:21 | _session is created once at module load with no TTL or periodic reset; CF cookie expiry causes silent failure |
| F8 | VERIFIED | src/sync/latest_sync.js:14–22 | startBackgroundLatestSync registers its own setTimeout+setInterval; all other jobs route through scheduler.js |

---

## 4. Phases and Steps

### Phase 1 — Foundation: shared helpers first

#### Step 1.1 — Export isOvaOrSpecialTitle from stringUtils.js

**Files:** `src/utils/stringUtils.js`

**Change:** Add and export a new function `isOvaOrSpecialTitle(title)` at the bottom of the file:
```js
export function isOvaOrSpecialTitle(title) {
    const t = (title || '').toLowerCase();
    return /\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)[\s-_]*\d+/i.test(t)
        || /\b(?:ova|oad|batch|nced|ncop|movie|film)\b/i.test(t)
        || /\((?:ova|oad|special|sp|ex|bonus|nced|ncop)\)|\b(?:ova|oad|special|sp|ex|bonus|nced|ncop)\b\s*$/i.test(t);
}
```
Do not remove or change any existing function. Do not touch any other file in this step.

**Also update:** nothing in this step.

**Verify:** `node --input-type=module <<< "import { isOvaOrSpecialTitle } from './src/utils/stringUtils.js'; console.log(isOvaOrSpecialTitle('OVA 1'), isOvaOrSpecialTitle('Episode 5'));"` — expected output: `true false`

**Rollback:** `git revert HEAD`

---

#### Step 1.2 — Replace inline OVA regex in episodeService.js with isOvaOrSpecialTitle

**Files:** `src/services/episodeService.js`

**Change:**
1. Add `isOvaOrSpecialTitle` to the import from `../utils/stringUtils.js` at line 2.
2. Remove the four module-level regex constants: `OVA_TITLE_RE`, `OVA_WORD_RE`, `OVA_PAREN_RE`, `OVA_URL_RE` (lines 17–21).
3. Remove the private `isOvaOrMovieTitle(title)` function (lines 23–25).
4. Replace every call-site that evaluates those regexes directly with a call to `isOvaOrSpecialTitle(title)`. There are three call sites:
   - In `sanitizeContaminatedEpisodeCards`: the `isOvaTitle` local variable.
   - In `deduplicateEpisodes`: the `isOvaCandidate` local variable.
   - In `scrapeAndMergeMulti`: the `isOvaTitle` check inside the merge loop.
5. The OVA_URL_RE (url-pattern check) is used only in `sanitizeContaminatedEpisodeCards` to remove contaminated URLs — keep that regex inline as a local `const OVA_URL_RE` inside that function only, since it tests URLs not titles and is a different concern.

**Also update:** nothing else imports `OVA_TITLE_RE` etc. — confirmed by grep.

**Verify:** `node src/server.js` starts without error. Then stop it.

**Rollback:** `git revert HEAD`

---

#### Step 1.3 — Replace inline OVA regex in animeOrchestrator.js with isOvaOrSpecialTitle

**Files:** `src/services/animeOrchestrator.js`

**Change:**
1. Add `isOvaOrSpecialTitle` to the import from `../utils/stringUtils.js` at line 3.
2. In `getUnifiedAnimeEpisodes`, inside the `.map()` at the transform step, replace the three inline regex tests that compute `isOvaTitle` (lines ~97–99) with a single call: `const isOvaTitle = isOvaOrSpecialTitle(ep.judul);`

**Also update:** nothing else.

**Verify:** `node src/server.js` starts without error. Then stop it.

**Rollback:** `git revert HEAD`

---

### Phase 2 — Cache consolidation

#### Step 2.1 — Remove LRUMemoryCache class from animeOrchestrator.js; use cacheManager

**Files:** `src/services/animeOrchestrator.js`, `src/utils/cacheManager.js`

**Change:**

In `src/utils/cacheManager.js`:
- Add `import { EventEmitter } from 'events';` — no, do not add dependencies.
- Instead: export a new named function `getOrchestatorCache()` that calls `getCache('orchestrator', 3600)` and returns it. The TTL matches the current 3600000ms (1 hour = 3600 seconds for NodeCache). Cap is already 500 via maxKeys in getCache.

  Add this at the bottom of cacheManager.js:
  ```js
  export function getOrchestratorCache() {
      return getCache('orchestrator', 3600);
  }
  ```

In `src/services/animeOrchestrator.js`:
1. Remove the entire `LRUMemoryCache` class (lines 8–55).
2. Remove `export const orchestratorCache = new LRUMemoryCache(1500, 3600000);`
3. Add import: `import { getOrchestratorCache } from '../utils/cacheManager.js';`
4. At the top of `getUnifiedAnimeEpisodes`, add: `const orchestratorCache = getOrchestratorCache();`
5. The rest of the function uses `orchestratorCache.get(cacheKey)` and `orchestratorCache.set(cacheKey, finalPayload)` — NodeCache uses the same `.get()` / `.set(key, value)` API so these calls are unchanged.
6. NodeCache `.set()` signature is `set(key, value, ttl?)` — no ttl arg needed since the namespace TTL is already set. No change required to existing `.set()` calls.

**Also update:** `src/utils/cacheManager.js` `flushAll()` currently does a dynamic import of animeOrchestrator to call `orchestratorCache.clear()`. Remove that dynamic import entirely — the orchestrator cache is now a NodeCache namespace registered in `caches`, so `flushAll()` already drains it via `Object.values(caches).forEach(c => c.flushAll())`.

**Verify:** `node src/server.js` starts without error. Confirm `flushAll` dynamic import line is gone from cacheManager.js. Then stop server.

**Rollback:** `git revert HEAD`

---

### Phase 3 — episodeService.js SRP split

#### Step 3.1 — Extract episodeMerger.js from episodeService.js

**Files:** `src/services/episodeMerger.js` (new), `src/services/episodeService.js`

**Change:**

Create `src/services/episodeMerger.js` containing exactly these exports moved from episodeService.js:
- `sanitizeContaminatedEpisodeCards(episodesList)` — full function body
- `deduplicateEpisodes(episodes)` — full function body

The new file imports:
```js
import { isSafeToMerge, isOvaOrSpecialTitle } from '../utils/stringUtils.js';
```

The local `OVA_URL_RE` constant (URL pattern, not title pattern) stays inside `sanitizeContaminatedEpisodeCards` as a local const — it is not exported.

In `src/services/episodeService.js`:
- Remove `sanitizeContaminatedEpisodeCards` and `deduplicateEpisodes` function bodies.
- Add import: `import { sanitizeContaminatedEpisodeCards, deduplicateEpisodes } from './episodeMerger.js';`

**Also update:**
- `src/services/animeOrchestrator.js` imports `sanitizeContaminatedEpisodeCards` from `./episodeService.js` — change that import to `./episodeMerger.js`.

**Verify:** `node src/server.js` starts without error. Confirm `sanitizeContaminatedEpisodeCards` is no longer defined in episodeService.js via: `grep -n "function sanitizeContaminatedEpisodeCards" src/services/episodeService.js` — expected: no output. Then stop server.

**Rollback:** `git revert HEAD`

---

#### Step 3.2 — Move auto-migrate write out of findAnimeInDatabase

**Files:** `src/services/episodeService.js`

**Change:** In `findAnimeInDatabase`, the block that calls `dbAnime.save()` when `sourceUrls` is empty (lines ~136–155) performs a write inside a read function. Remove the save call and the associated `console.log` and `try/catch` around it. The migration logic (building `newUrls` from `dbAnime.sources`) can remain as read-only: still populate `dbAnime.sourceUrls` in-memory so the caller gets a consistent object, but do NOT call `dbAnime.save()` here. Add a comment: `// ponytail: auto-migrate write removed; run scripts/migrate_v1_to_v2.js to persist legacy docs`.

**Also update:** nothing else.

**Verify:** `node src/server.js` starts without error. Confirm `dbAnime.save()` does not appear inside `findAnimeInDatabase` via: `grep -n "dbAnime.save" src/services/episodeService.js` — all remaining hits should be inside `finalizeScrapedData` only. Then stop server.

**Rollback:** `git revert HEAD`

---

#### Step 3.3 — Remove LEGACY_DB_FALLBACK branch from findAnimeInDatabase

**Files:** `src/services/episodeService.js`

**Change:** Remove the entire `if (!dbAnime && process.env.LEGACY_DB_FALLBACK === 'true')` block (the block that builds `legacyOrQuery` across all provider schema paths). The comment above it warns it causes a full collection scan. Replace it with a single comment: `// Legacy schema fallback removed; use scripts/migrate_v1_to_v2.js to migrate old docs.`

**Also update:** nothing else.

**Verify:** `node src/server.js` starts without error. Confirm `LEGACY_DB_FALLBACK` no longer appears in episodeService.js via: `grep -n "LEGACY_DB_FALLBACK" src/services/episodeService.js` — expected: no output. Then stop server.

**Rollback:** `git revert HEAD`

---

### Phase 4 — DB write performance

#### Step 4.1 — Replace sequential save loop in unified_sync.js with bulkWrite

**Files:** `src/sync/unified_sync.js`

**Change:** The current `for (const anime of unenrichedAnimes)` loop ends each branch with `await anime.save()`. Restructure to collect MongoDB update operations into an array and fire one `Anime.bulkWrite(ops)` after the loop.

Exact restructure:
1. Before the loop, declare `const bulkOps = [];`
2. Inside the loop, for each branch that currently calls `anime.save()`, instead push a `{ updateOne: { filter: { _id: anime._id }, update: { $set: { ...fields } } } }` object to `bulkOps`. The `fields` object should contain exactly the fields that were being assigned before the `.save()` call.
3. For the merge-and-delete branch (existingDuplicate): keep `existingDuplicate.save()` and `Anime.deleteOne()` as-is since these are two different documents and cannot be combined into one bulkWrite op with the rest. This branch is already rare (duplicate detection).
4. After the loop, if `bulkOps.length > 0`, call `await Anime.bulkWrite(bulkOps)`.
5. Remove all `await anime.save()` calls from the main enrichment branches (non-duplicate branches).

**Also update:** nothing else.

**Verify:** `node src/server.js` starts without error. Confirm no `await anime.save()` remains in the main for-loop body (outside the existingDuplicate branch): `grep -n "anime.save" src/sync/unified_sync.js` — expected: zero hits or only inside the existingDuplicate block. Then stop server.

**Rollback:** `git revert HEAD`

---

### Phase 5 — Scheduler consolidation

#### Step 5.1 — Move latest_sync timers into scheduler.js

**Files:** `src/sync/latest_sync.js`, `src/jobs/scheduler.js`

**Change:**

In `src/sync/latest_sync.js`:
- Remove `startBackgroundLatestSync()` export entirely (the function that registers `setTimeout` + `setInterval` on lines 14–22).
- Keep `runLatestSync()` exported as-is — scheduler.js will call it directly.
- Keep `processLatestUpdatesWithGuard` and `extractEpisodeNumFromText` as-is.

In `src/jobs/scheduler.js`:
- Change import: replace `import { startBackgroundLatestSync } from '../sync/latest_sync.js';` with `import { runLatestSync } from '../sync/latest_sync.js';`
- Remove the call to `startBackgroundLatestSync()` in `initScheduler()`.
- Add in its place a scheduler-owned timer block that matches the previous behavior:
  ```js
  // Latest sync: run once after 20s (pool warm-up), then every 30 minutes
  setTimeout(() => runLatestSync(), 20000);
  setInterval(() => runLatestSync(), 1800000);
  ```

**Also update:** nothing else imports `startBackgroundLatestSync` — confirmed by grep.

**Verify:** `node src/server.js` starts without error. Confirm `startBackgroundLatestSync` no longer exists in latest_sync.js: `grep -n "startBackgroundLatestSync" src/sync/latest_sync.js` — expected: no output. Then stop server.

**Rollback:** `git revert HEAD`

---

### Phase 6 — Python session TTL

#### Step 6.1 — Add periodic session reset to python/fetcher.py

**Files:** `python/fetcher.py`

**Change:** The module-level `_session` is created once and never refreshed. Add a session reset mechanism:

1. Add `import threading` and `import time` at the top of the file.
2. After `_session = cf_requests.Session(impersonate=IMPERSONATE)`, add:
   ```python
   _session_lock = threading.Lock()
   _SESSION_TTL = 2 * 60 * 60  # 2 hours

   def _reset_session():
       global _session
       while True:
           time.sleep(_SESSION_TTL)
           with _session_lock:
               _session = cf_requests.Session(impersonate=IMPERSONATE)
           log.info("curl_cffi session direset (TTL habis).")

   _reset_thread = threading.Thread(target=_reset_session, daemon=True)
   _reset_thread.start()
   ```
3. In `fetch_html`, wrap the `_session.get()` calls with `with _session_lock:` to prevent a reset mid-request.

**Also update:** nothing else.

**Verify:** `python python/scraper_service.py &` — starts without error. Stop it. Confirm `_reset_thread` appears in fetcher.py: `grep -n "_reset_thread" python/fetcher.py` — expected: at least one hit.

**Rollback:** `git revert HEAD`

---

## 5. Needs My Decision

None. All findings are VERIFIED and all steps are self-contained.

---

## 6. Risks

| Phase | Risk | How to notice |
|-------|------|---------------|
| Phase 2 (cache) | NodeCache .set() TTL behavior differs from hand-rolled LRU eviction under memory pressure | Episode lists served stale longer than 1 hour; check logs for cache hits |
| Phase 3.1 (SRP split) | animeOrchestrator import path change breaks if module resolution differs | Server startup error: "Cannot find module ./episodeMerger.js" |
| Phase 3.2/3.3 (auto-migrate/legacy removal) | Anime docs still in legacy format will no longer be auto-migrated on read | findAnimeInDatabase returns null for old-format docs; run migrate_v1_to_v2.js as a one-time fix |
| Phase 4 (bulkWrite) | bulkWrite field mapping error causes silent no-op updates | enrichedCount increments but tmdbEnriched stays false in DB |
| Phase 6 (Python TTL) | Lock contention on high-traffic scrape bursts | fetch_html latency spike; monitor logs |

---

## 7. Noticed but Out of Scope

- F3 partial: `findAnimeInDatabase` could be further split into its own dbQueryHelper.js — deferred, too large for this plan.
- malId assigned twice in unified_sync.js (lines ~85 and ~96) — duplicate assignment, not a bug, low priority.
- NodeCache maxKeys is 500 per namespace; the old LRU was 1500 — this is a capacity reduction. Acceptable given 1GB RAM constraint, but monitor if cache eviction spikes under load.
