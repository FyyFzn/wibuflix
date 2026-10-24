# PLAN: Blob Storage Stale Segment Cleanup

## 1. Goal and Scope

Add a scheduled daily job that deletes all blobs older than 7 days from Azure Blob Storage
to prevent unbounded storage growth and reduce monthly Azure cost.

In scope:
- New utility module `src/utils/blobCleanupWorker.js` — sole responsibility: list and delete stale blobs
- Register the job in `src/jobs/scheduler.js`
- `src/services/stream/blobStorageService.js` — expose `containerClient` access (already exported, no change needed)

Out of scope:
- Any changes to the transcode, upload, or stream pipeline
- Changes to `uploadCache` or `streamStateStore.js`
- MongoDB changes
- Any frontend changes

Done means:
- `blobCleanupWorker.js` exists, lists all blobs in the container, deletes those whose `createdOn`
  is older than 7 days, and logs each deletion
- Scheduler calls it once at startup (after a 30s delay) then every 24 hours
- Server starts cleanly with no errors

---

## 2. Executor Rules

- Follow phases and steps in order, one at a time.
- Commit after each step: `git add -A && git commit -m "<type>(<scope>): <step description>"`
- If code does not match what the step describes, STOP and report the mismatch.
- Do not improvise or fix adjacent things.
- Do not add dependencies, rename things, or change behavior outside the step.
- Run the step's verification before moving on. If it fails, stop and report.
- For backend steps: verify server starts with `node src/server.js` before committing.
- Do NOT update any skill file. Skill updates are handled by the senior model after verification.

---

## 3. Findings

| ID | Status | File:Line | Description |
|----|--------|-----------|-------------|
| F1 | VERIFIED | `src/services/stream/blobStorageService.js:7` | `containerClient` is exported as a named export |
| F2 | VERIFIED | `src/services/stream/blobStorageService.js:130` | `deleteBlobFromAzure(blobPath)` already exists and handles `deleteIfExists` |
| F3 | VERIFIED | `src/jobs/scheduler.js:54` | `scheduledCleanup()` from `tempFileCleanupWorker.js` is called directly in `initScheduler()` with no delay |
| F4 | VERIFIED | `src/jobs/scheduler.js:11` | Scheduler imports from `../utils/tempFileCleanupWorker.js` — same pattern to follow for new worker |
| F5 | VERIFIED | `src/utils/tempFileCleanupWorker.js:68` | `scheduledCleanup()` runs once immediately then every 12h via `setInterval` — same pattern to use |
| F6 | VERIFIED | `src/services/stream/blobStorageService.js:46` | `ensureContainerExists()` is exported and must be called before listing blobs |

---

## 4. Phases and Steps

### Phase 1 — Create the cleanup worker

**Step 0 — Commit plan file**
- **Files:** `plans/PLAN-2026-10-24-blob-stale-cleanup.md`
- **Change:** No source code changes. Stage and commit plan file alone.
- **Verify:** `git log --oneline -1` shows commit touching only the plan file.
- **Commit:** `docs(plans): PLAN-2026-10-24-blob-stale-cleanup.md`
- **Rollback:** `git revert HEAD`

---

**Step 1 — Create `src/utils/blobCleanupWorker.js`**

- **Files:** `src/utils/blobCleanupWorker.js` (new file)
- **Change:** Create the file with a single exported function `scheduledBlobCleanup()`.

The file must:
1. Import `containerClient` and `ensureContainerExists` from `../../services/stream/blobStorageService.js`
   (note the relative path from `src/utils/` to `src/services/stream/`)
2. Define `const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000` (7 days in milliseconds)
3. Define an async function `deleteStaleBlobs()` that:
   - Returns early (no-op, no error) if `containerClient` is null
   - Calls `await ensureContainerExists()`
   - Lists all blobs using `containerClient.listBlobsFlat()` — this returns an async iterator
   - For each blob item: check if `item.properties.createdOn` exists and
     `Date.now() - new Date(item.properties.createdOn).getTime() > STALE_THRESHOLD_MS`
   - If stale: call `await containerClient.getBlockBlobClient(item.name).deleteIfExists()`
     and log `[BlobCleanup] Menghapus blob kadaluarsa: ${item.name}`
   - Wrap the entire iteration in try/catch; on error: log
     `[BlobCleanup] Gagal membersihkan blob: ${err.message}` (no rethrow)
4. Export function `scheduledBlobCleanup()` that:
   - Calls `deleteStaleBlobs()` once after a 30-second delay (use `setTimeout`)
   - Then calls `deleteStaleBlobs()` every 24 hours (use `setInterval`)
   - The 30-second initial delay prevents the cleanup from racing against server cold start

Full file structure:

```js
import { containerClient, ensureContainerExists } from '../services/stream/blobStorageService.js';

const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

async function deleteStaleBlobs() {
    if (!containerClient) return;
    try {
        await ensureContainerExists();
        let deleted = 0;
        for await (const item of containerClient.listBlobsFlat()) {
            if (item.properties?.createdOn) {
                const age = Date.now() - new Date(item.properties.createdOn).getTime();
                if (age > STALE_THRESHOLD_MS) {
                    await containerClient.getBlockBlobClient(item.name).deleteIfExists();
                    console.log(`[BlobCleanup] Menghapus blob kadaluarsa: ${item.name}`);
                    deleted++;
                }
            }
        }
        if (deleted > 0) {
            console.info(`[BlobCleanup] Selesai. Total dihapus: ${deleted} blob.`);
        } else {
            console.info('[BlobCleanup] Tidak ada blob kadaluarsa yang ditemukan.');
        }
    } catch (err) {
        console.error(`[BlobCleanup] Gagal membersihkan blob: ${err.message}`);
    }
}

export function scheduledBlobCleanup() {
    setTimeout(() => deleteStaleBlobs(), 30000);
    setInterval(() => deleteStaleBlobs(), 24 * 60 * 60 * 1000);
}
```

- **Verify:** `node --input-type=module <<< "import './src/utils/blobCleanupWorker.js'"` exits with code 0 (no syntax errors)
- **Commit:** `feat(blobCleanupWorker): add scheduled stale blob deletion older than 7 days`
- **Rollback:** `git revert HEAD`

---

### Phase 2 — Register in scheduler

**Step 2 — Register `scheduledBlobCleanup` in `src/jobs/scheduler.js`**

- **Files:** `src/jobs/scheduler.js`
- **Change:**
  1. Add import at the top of the file alongside other imports:
     ```js
     import { scheduledBlobCleanup } from '../utils/blobCleanupWorker.js';
     ```
  2. Inside `initScheduler()`, after the `scheduledCleanup()` call (line 54), add:
     ```js
     // 3b. Pembersihan blob Azure kadaluarsa (lebih dari 7 hari) setiap 24 jam
     scheduledBlobCleanup();
     ```
- **Also update:** nothing else imports scheduler; no other file needs changing
- **Verify:** `node src/server.js` starts without errors. Check logs show
  `[Scheduler] Semua background jobs` line. Kill the server after confirming.
- **Commit:** `feat(scheduler): register scheduledBlobCleanup for daily Azure blob pruning`
- **Rollback:** `git revert HEAD`

---

## 5. Needs My Decision

None. All implementation details are fully specified.

---

## 6. Risks

| Phase | Risk | How to notice |
|-------|------|---------------|
| Phase 1 | `listBlobsFlat()` iterates all blobs including active ones; a blob uploaded seconds ago with `createdOn` < 7 days is safe — only concern is clock skew on Azure side | Unlikely; Azure blob timestamps are server-side |
| Phase 1 | If `containerClient` is null (env var not set), `deleteStaleBlobs` returns early silently — no crash | Safe by design |
| Phase 2 | If server restart happens during the 30s delay window, cleanup is skipped for that boot — acceptable, it runs on next boot | No data loss risk |

---

## 7. Noticed but Out of Scope

- `deleteBlobFromAzure` in `blobStorageService.js` (line 130) already exists but is only called on upload failure cleanup. Could be reused here but introduces a cross-layer import from `utils/` into `services/` indirection — not worth it, keep new worker self-contained.
- No access time tracking exists; smart LRU-based deletion would require MongoDB instrumentation — out of scope for this plan.
- Blob Storage lifecycle policies exist natively in Azure portal (no code needed) — but require portal access and can't be version-controlled. Code-based cleanup is preferred for auditability.

---

## 8. After Execution

When all steps are complete, the executor must reply with:
- Which steps completed fully vs partially
- Any deviations from the plan

Do not update the wibuflix skill or any skill file.
The senior model will run verify-plan, confirm correctness, then update the skill.
