# PLAN: Standalone Wibuflix Web Client for Vercel (wibuflix-web)

## 1. Goal and Scope

**Goal:**
Create a standalone web version of Wibuflix inside the repository root at `wibuflix-web/` using Vite + React + TypeScript + Tailwind CSS, designed for zero-compute deployment on Vercel. It matches all non-admin features of the mobile app (Home, Katalog, Detail, Player, History, Queue) and synchronizes watch history and playback progress with the backend MongoDB.

**Depends on:** `plans/PLAN-2026-10-22-backend-history-sync.md` (Backend `/api/history` must be operational).

**What's in:**
- Standalone folder `wibuflix-web/` at repo root.
- Dependencies: `react`, `react-dom`, `react-router-dom`, `lucide-react`, `hls.js`, `tailwindcss`, `clsx`, `tailwind-merge`.
- API and Storage services:
  - `wibuflix-web/src/services/api.ts`: Facade for backend endpoints (katalog, hot, episodes, scrape, smart-play, queue).
  - `wibuflix-web/src/services/storage.ts`: History management with `localStorage` and background sync with `GET/POST /api/history`.
- Pages:
  - Home (`/`): Featured hero banner, hot anime list, latest updates.
  - Katalog (`/katalog`): Grid with live search, genre filters, and pagination.
  - Detail (`/detail/:id`): Synopsis, rating, genre tags, episode list with last-watched indicator.
  - Player (`/player`): HTML5 `<video>` powered by `hls.js`, fullscreen, episode navigation, auto-resume, progress persistence every 5s, and iframe embed fallback.
  - History (`/history`): Watch history cards with progress bars and continue-watch links.
  - Queue (`/queue`): Live HLS transcoding task monitor via SSE (`/api/queue/stream`).
- Vercel SPA deployment configuration (`wibuflix-web/vercel.json`).

**What's out:**
- Admin portal, AI Chat, and Kurasi/Merge tools (strictly excluded).
- Server-side rendering (SPA client-side only).
- Direct backend bundling or container changes (deployed independently on Vercel).

**Done means:**
- `wibuflix-web/` builds cleanly with `npm --prefix wibuflix-web run build`.
- `npx tsc --noEmit` passes with 0 type errors in `wibuflix-web/`.
- Video streams play smoothly via HLS.js or embed iframe.
- Watch progress accurately syncs to MongoDB and matches mobile watch progress.

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
| F1 | VERIFIED | `src/config/providerUrls.js` | Backend API base URL is `https://api.wibuflix.me`. |
| F2 | VERIFIED | `wibuflix-app/services/endpoints/` | Existing API shapes: `KatalogResponse`, `HotAnimeResponse`, `EpisodesResponse`, `QueueItem`, `SmartPlayResponse`. |
| F3 | VERIFIED | `src/routes/proxy.js:10-85` | HLS proxy routes exist for third-party m3u8 streams (`/api/proxy/filedon`). |
| F4 | VERIFIED | `src/routes/extract.js:28-32` | Queue status and SSE endpoints are active at `/api/queue/status` and `/api/queue/stream`. |

## 4. Phases and Steps

### Phase 1: Project Scaffolding & Core Architecture

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-10-22-web-app-vercel.md`
- **Change:** No source code changes. Stage and commit the plan file alone.
- **Verify:** `git log --oneline -1` shows a commit with only the plan file.
- **Commit message:** `docs(plans): add PLAN-2026-10-22-web-app-vercel.md`
- **Rollback:** `git revert HEAD`

**Step 1 — Initialize wibuflix-web Workspace with Vite and Tailwind**
- **Files:**
  - `wibuflix-web/package.json`
  - `wibuflix-web/vite.config.ts`
  - `wibuflix-web/tsconfig.json`
  - `wibuflix-web/tsconfig.node.json`
  - `wibuflix-web/index.html`
  - `wibuflix-web/tailwind.config.js`
  - `wibuflix-web/postcss.config.js`
  - `wibuflix-web/src/index.css`
  - `wibuflix-web/src/main.tsx`
- **Change:**
  - Initialize Vite React + TypeScript project in `wibuflix-web/`.
  - Install dependencies: `react`, `react-dom`, `react-router-dom`, `lucide-react`, `hls.js`, `tailwindcss`, `postcss`, `autoprefixer`.
  - Configure Tailwind with dark theme colors: background `#0F1017`, surface `#181926`, card `#1E1F2E`, accent `#FF5722`.
- **Verify:** Run `npm --prefix wibuflix-web run build`.
- **Rollback:** Delete `wibuflix-web/` directory.
- **Commit message:** `feat(web): initialize wibuflix-web Vite React project with Tailwind`

**Step 2 — API Client and History Storage Bridge**
- **Files:** `wibuflix-web/src/services/api.ts`, `wibuflix-web/src/services/storage.ts`, `wibuflix-web/src/types/index.ts`
- **Change:**
  - Define shared TypeScript interfaces: `AnimeItem`, `EpisodeItem`, `WatchHistoryItem`, `QueueItem`, `ServerItem`.
  - Implement `api.ts`: Client communicating with `import.meta.env.VITE_API_BASE || 'https://api.wibuflix.me'`. Inject `x-sync-token` from `localStorage`. Implement endpoints: `fetchKatalog`, `fetchHotAnime`, `fetchEpisodes`, `scrapeVideo`, `fetchSmartPlay`, `fetchQueueStatus`.
  - Implement `storage.ts`: Read/write `WatchHistoryItem` in `localStorage`, push progress updates to `POST /api/history`, sync with `GET /api/history`.
- **Verify:** `npx tsc --noEmit` in `wibuflix-web/` passes.
- **Rollback:** `git checkout HEAD -- wibuflix-web/src/services/ wibuflix-web/src/types/`
- **Commit message:** `feat(web): add API client, types, and history storage bridge`

### Phase 2: Layout & Navigation

**Step 3 — Build Navbar, Footer, and Sync Modal**
- **Files:**
  - `wibuflix-web/src/components/Navbar.tsx`
  - `wibuflix-web/src/components/Footer.tsx`
  - `wibuflix-web/src/components/SyncTokenModal.tsx`
  - `wibuflix-web/src/components/AnimeCard.tsx`
  - `wibuflix-web/src/App.tsx`
- **Change:**
  - Responsive Navbar with navigation items: Beranda (`/`), Katalog (`/katalog`), Riwayat (`/history`), Antrean (`/queue`).
  - Sync Token button opening `SyncTokenModal` to view and configure the user's sync token.
  - Reusable `AnimeCard` component with hover effects, rating badge, and poster image.
- **Verify:** `npx tsc --noEmit` in `wibuflix-web/` passes.
- **Rollback:** `git checkout HEAD -- wibuflix-web/src/components/ wibuflix-web/src/App.tsx`
- **Commit message:** `feat(web): implement Navbar, Footer, SyncModal, and AnimeCard`

### Phase 3: Core Pages & Video Player

**Step 4 — Implement Home, Katalog, and Queue Pages**
- **Files:**
  - `wibuflix-web/src/pages/HomePage.tsx`
  - `wibuflix-web/src/pages/KatalogPage.tsx`
  - `wibuflix-web/src/pages/QueuePage.tsx`
- **Change:**
  - `HomePage`: Hero banner showing featured anime, trending section, and latest anime grid.
  - `KatalogPage`: Search bar, genre pills, sort options, and paginated grid.
  - `QueuePage`: Real-time SSE table of active HLS transcoding tasks (`/api/queue/stream`) with action buttons (cancel, prioritize).
- **Verify:** `npx tsc --noEmit` in `wibuflix-web/` passes.
- **Rollback:** `git checkout HEAD -- wibuflix-web/src/pages/`
- **Commit message:** `feat(web): implement HomePage, KatalogPage, and QueuePage`

**Step 5 — Implement Detail and Video Player Pages**
- **Files:**
  - `wibuflix-web/src/pages/DetailPage.tsx`
  - `wibuflix-web/src/pages/PlayerPage.tsx`
  - `wibuflix-web/src/components/PlayerControls.tsx`
- **Change:**
  - `DetailPage`: Metadata header (synopsis, score, status), episode list, and "Lanjutkan Nonton" shortcut if in watch history.
  - `PlayerPage`:
    - Video playback using `<video>` element with `hls.js` support for `.m3u8` and Azure Blob streams.
    - Iframe fallback when source is an external embed (pixeldrain, wibufile, etc.).
    - Resume saved progress from history.
    - Auto-save progress to `/api/history` every 5 seconds and on pause/unload.
    - Next/Previous episode navigation and server switcher.
- **Verify:** `npx tsc --noEmit` in `wibuflix-web/` passes.
- **Rollback:** `git checkout HEAD -- wibuflix-web/src/pages/DetailPage.tsx wibuflix-web/src/pages/PlayerPage.tsx`
- **Commit message:** `feat(web): implement DetailPage and PlayerPage with HLS.js`

**Step 6 — Implement History Page and Vercel Configuration**
- **Files:**
  - `wibuflix-web/src/pages/HistoryPage.tsx`
  - `wibuflix-web/vercel.json`
- **Change:**
  - `HistoryPage`: Grid of watched anime with progress bars, last watched episode badge, time ago label, and "Hapus Semua" action.
  - `vercel.json`: Configure client-side SPA routing:
    ```json
    {
      "rewrites": [
        { "source": "/(.*)", "destination": "/index.html" }
      ]
    }
    ```
- **Verify:**
  - Run `npm --prefix wibuflix-web run build`.
  - Verify `wibuflix-web/dist/` is generated.
- **Rollback:** `git checkout HEAD -- wibuflix-web/src/pages/HistoryPage.tsx wibuflix-web/vercel.json`
- **Commit message:** `feat(web): implement HistoryPage and Vercel routing configuration`

## 5. Needs My Decision
None.

## 6. Risks
- **CORS for External Streams:** Azure Blob Storage HLS streams play directly in the browser provided Azure Blob CORS is enabled. External stream proxies route via backend `/api/proxy/filedon`.

## 7. Noticed but Out of Scope
- PWA / Service Worker offline caching for the web client.

## 8. After Execution
When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.
The senior model will run verify-plan, confirm correctness, then update the skill.
