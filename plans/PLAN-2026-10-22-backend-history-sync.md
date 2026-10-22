# PLAN: Backend Watch History Synchronization API

## 1. Goal and Scope

**Goal:**
Add a persistent watch history and progress tracking API to the Wibuflix backend in MongoDB, protected by a simple single-user sync token (`SYNC_TOKEN`), allowing both mobile and web clients to sync watch progress bidirectionally.

**Depends on:** None. Executes first.

**What's in:**
- MongoDB model: `src/models/WatchHistory.js`.
- Auth middleware: `src/middlewares/authMiddleware.js` to validate `x-sync-token` against `process.env.SYNC_TOKEN`.
- Controller: `src/controllers/historyController.js` for CRUD operations (`getHistory`, `upsertHistory`, `deleteHistoryItem`, `clearHistory`).
- Routes: `src/routes/history.js` exposing `/api/history`.
- Route registration & CORS header configuration in `src/server.js`.

**What's out:**
- Multi-user authentication / JWT / user registration.
- Any modifications to mobile or web client files (handled in respective plans).

**Done means:**
- `GET /api/history` returns saved watch history items sorted by `waktu` desc.
- `POST /api/history` upserts an item by episode URL or series URL, updating timestamp and progress.
- `DELETE /api/history/:identifier` removes a single item.
- `DELETE /api/history` flushes all history.
- Requests without a valid `x-sync-token` are rejected with HTTP 401 when `SYNC_TOKEN` is set.
- Backend server boots cleanly (`node src/server.js`) without errors.

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
|---|---|---|---|
| F1 | VERIFIED | `src/models/` | Models present: `Anime.js`, `QueueTask.js`, `TMDBCache.js`. No `WatchHistory.js` exists. |
| F2 | VERIFIED | `src/server.js:69-70` | `app.use(cors())` and `app.use(express.json())` already present at root. |
| F3 | VERIFIED | `src/server.js:78-85` | Routers mounted at root (`v2Router`, `katalogRouter`, `scrapeRouter`, etc.). |
| F4 | VERIFIED | `wibuflix-app/services/storage.ts:13-24` | `WatchHistoryItem` contract: `judulSeri`, `nomorEp`, `url`, `seriUrl`, `gambar`, `waktu`, `progress`, `duration`, `host`, `uniqueId`. |

## 4. Phases and Steps

### Phase 1: Database Model & Middleware

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-22-backend-history-sync.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-22-backend-history-sync.md`
- **Rollback:** `git revert HEAD`

**Step 1 — Create WatchHistory Mongoose Model**
- **Files:** `src/models/WatchHistory.js`
- **Change:** Create schema matching client contract:
  ```javascript
  import mongoose from 'mongoose';

  const WatchHistorySchema = new mongoose.Schema({
      judulSeri: { type: String, required: true },
      nomorEp: { type: String, default: '' },
      url: { type: String, required: true, index: true },
      seriUrl: { type: String, index: true },
      gambar: { type: String, default: '' },
      waktu: { type: Number, default: () => Date.now(), index: true },
      progress: { type: Number, default: 0 },
      duration: { type: Number, default: 0 },
      host: { type: String, default: '' },
      uniqueId: { type: String, default: '' }
  }, { timestamps: true });

  export default mongoose.model('WatchHistory', WatchHistorySchema);
  ```
- **Verify:** `node -e "import('./src/models/WatchHistory.js')"` executes with no errors.
- **Rollback:** `git checkout HEAD -- src/models/WatchHistory.js`
- **Commit message:** `feat(models): add WatchHistory mongoose model`

**Step 2 — Create Sync Token Auth Middleware**
- **Files:** `src/middlewares/authMiddleware.js`
- **Change:** Create middleware validating `x-sync-token`:
  ```javascript
  export function syncAuthMiddleware(req, res, next) {
      const expectedToken = process.env.SYNC_TOKEN;
      if (!expectedToken) {
          // If SYNC_TOKEN is not configured in .env, allow access with warning
          return next();
      }

      const clientToken = req.headers['x-sync-token'];
      if (!clientToken || clientToken !== expectedToken) {
          return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid or missing x-sync-token' });
      }

      next();
  }
  ```
- **Verify:** `node -e "import('./src/middlewares/authMiddleware.js')"` executes with no errors.
- **Rollback:** `git checkout HEAD -- src/middlewares/authMiddleware.js`
- **Commit message:** `feat(middlewares): add syncAuthMiddleware for sync token validation`

### Phase 2: History Controller and Router

**Step 3 — Create History Controller**
- **Files:** `src/controllers/historyController.js`
- **Change:** Implement `getHistory`, `upsertHistory`, `deleteHistoryItem`, and `clearHistory`:
  - `getHistory`: Query `WatchHistory.find().sort({ waktu: -1 }).limit(100).lean()`. Return `{ status: 'success', data }`.
  - `upsertHistory`: Extract body fields (`judulSeri`, `nomorEp`, `url`, `seriUrl`, `gambar`, `progress`, `duration`, `host`, `uniqueId`, `waktu`). Upsert using `findOneAndUpdate({ $or: [{ url }, { seriUrl }] }, updateDoc, { upsert: true, new: true })`.
  - `deleteHistoryItem`: Extract `identifier` from `req.params`. Delete matching `url: identifier` or `seriUrl: identifier` or `judulSeri: identifier`.
  - `clearHistory`: `WatchHistory.deleteMany({})`.
- **Verify:** `node -e "import('./src/controllers/historyController.js')"` executes with no errors.
- **Rollback:** `git checkout HEAD -- src/controllers/historyController.js`
- **Commit message:** `feat(controllers): add historyController for watch history operations`

**Step 4 — Create History Router and Mount in Server**
- **Files:** `src/routes/history.js`, `src/server.js`
- **Change:**
  - `src/routes/history.js`:
    ```javascript
    import express from 'express';
    import { getHistory, upsertHistory, deleteHistoryItem, clearHistory } from '../controllers/historyController.js';
    import { syncAuthMiddleware } from '../middlewares/authMiddleware.js';

    const router = express.Router();
    router.use(syncAuthMiddleware);
    router.get('/api/history', getHistory);
    router.post('/api/history', upsertHistory);
    router.delete('/api/history', clearHistory);
    router.delete('/api/history/:identifier', deleteHistoryItem);

    export default router;
    ```
  - In `src/server.js`:
    - Import `historyRouter from './routes/history.js'`.
    - Mount `app.use(historyRouter);` alongside existing routers.
- **Verify:**
  - Start server: `node src/server.js` (starts and prints banner without exceptions).
  - Stop server.
- **Rollback:** `git checkout HEAD -- src/routes/history.js src/server.js`
- **Commit message:** `feat(server): mount historyRouter at /api/history`

## 5. Needs My Decision
None.

## 6. Risks
- **Token Configuration:** If `SYNC_TOKEN` is not set in `.env`, the middleware gracefully permits requests so clients work during initial setup.

## 7. Noticed but Out of Scope
- Sync conflict resolution: If timestamps differ, latest `waktu` wins (standard LWW - Last Write Wins).

## 8. After Execution
When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.
The senior model will run verify-plan, confirm correctness, then update the skill.
