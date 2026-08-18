# AGENTS.md — Wibuflix Monorepo

Root-level agent configuration governing all AI-assisted development across this workspace.
These rules apply globally unless overridden by a directory-scoped `AGENTS.md`.

---

## Workspace Architecture

This repository is a monorepo containing two independent, deployable projects:

| Directory | Project Name | Role |
|---|---|---|
| `samehadaku-scraper/` | Wibuflix Backend | Node.js scraping service + HLS transcoding + Azure Blob Storage pipeline |
| `wibuflix-app/` | Wibuflix Frontend | React client application |

No code, logic, or utilities may be shared across these two project directories unless placed in an explicitly designated shared package with its own clearly scoped responsibility.

---

## Global Engineering Standards

- All source files must be written with a single, clearly defined responsibility.
- No file may contain logic spanning more than one concern domain.
- No monolithic scripts. Every distinct operation must be isolated in its own module.
- All functions must be pure or clearly side-effect-documented where impure.
- No inline TODO comments left unresolved after a task is completed.
- Secrets, credentials, and environment-specific values must never be hardcoded; use `.env` and environment variable injection exclusively.

---

## Absolute System Rule — Single Responsibility Principle (SRP)

**Every file must have exactly one clearly defined job. This is non-negotiable.**

### Enforcement Directives

- Scraping pipelines, Azure file upload utilities, HLS transcoding services, React UI components, and API fetch calls must each reside in distinct, specialized files.
- If the agent identifies that an existing file has grown to handle multiple concerns, it **must** proactively refactor and split that file before introducing further changes.
- The agent must never add a new responsibility to a file that already fulfills one.
- Naming conventions must reflect single responsibility — a file named `scraper.js` must only scrape; a file named `uploader.js` must only upload.

### Prohibited Patterns

- Scraping logic and Azure upload logic co-located in the same file.
- React component files that also contain `fetch`/`axios` API call logic inline.
- A single entry-point file that orchestrates, validates, transforms, and persists data.
- Utility functions mixed into business logic modules.

### Actual Source Tree (Ground Truth)

The backend does **not** use a flat `src/scrapers/`, `src/uploaders/`, `src/pipelines/` layout.
The real directory structure, as verified by code inspection, is:

```
samehadaku-scraper/
  src/
    config/
      db.js                      ← MongoDB connection setup
      providerUrls.js            ← SSOT for all provider base URLs and domain keywords
    controllers/                 ← HTTP request handlers; delegate all logic to services
    dtos/                        ← Data Transfer Objects; shape normalized API responses
    jobs/
      scheduler.js               ← Background job scheduling (cron-style tasks)
    middlewares/
      errorHandler.js            ← Express global error handler
      urlValidator.js            ← SSRF protection middleware
    models/                      ← Mongoose schemas (Anime, QueueTask, TMDBCache)
    puppeteer/
      browserPool.js             ← Puppeteer browser instance pool lifecycle
      circuitBreaker.js          ← Circuit breaker for browser pool stability
      concurrencyGuard.js        ← Guard against concurrent Puppeteer resource abuse
      cookieSessionStore.js      ← Cloudflare cookie/session storage for Puppeteer
      pool.js                    ← Public pool API (initPagePool, releaseToPool, etc.)
    routes/                      ← Express router definitions; no business logic
    scripts/                     ← One-off administrative or maintenance scripts
    services/
      ProviderRegistry.js        ← Runtime registry mapping provider IDs to scraper modules
      animeOrchestrator.js       ← Orchestrates episode data aggregation with LRU cache
      canonicalService.js        ← Canonical slug/URL resolution logic
      episodeService.js          ← Episode data retrieval and normalization
      prefetchService.js         ← Background prefetch pipeline coordinator
      slugService.js             ← Slug generation and lookup
      streamRankingService.js    ← Stream source ranking and scoring
      extractors/
        videoExtractor.js        ← Entry-point dispatcher for all video URL extraction
        providers/               ← One file per hosting provider (acefile, gdrive, etc.)
      metadata/
        jikan.js                 ← Jikan API (MAL) metadata fetcher
        tmdb.js                  ← TMDB metadata fetcher
      scrapers/
        *.js                     ← One file per source website; scrapes HTML from its corresponding site only
      stream/
        azureSegmentUploader.js  ← Upload .ts/.m3u8 segments to Azure Blob Storage
        blobStorageService.js    ← Azure SDK instantiation, container client, blob path utils
        downloaderClient.js      ← Download HLS streams from source providers
        ffmpegStreamService.js   ← FFmpeg process management for HLS transcoding
        hlsTranscoder.js         ← HLS transcoding pipeline orchestration
        streamFailoverService.js ← Failover logic between stream sources
        streamMetadataEnricher.js← Enrich stream metadata before delivery
        streamStateStore.js      ← In-memory upload state/progress cache
        uploadProgressService.js ← Upload lifecycle management and cancellation
    sync/                        ← Per-provider sync workers that pull new anime/episode data
    tests/                       ← Test suites
    utils/
      animeMatcher.js            ← Fuzzy matching between scraped titles and DB entries
      cacheManager.js            ← Shared in-process cache factory
      circuitBreaker.js          ← Generic circuit breaker utility
      contractValidator.js       ← Runtime schema validation for scraper output contracts
      deduplicator.js            ← Deduplication utility for episode/stream lists
      kuronimeDecryptor.js       ← Kuronime-specific video source decryption
      logger.js                  ← Logging utility (productionSilent mode support)
      malEnrichment.js           ← MAL-specific data enrichment helpers
      neosatsuUtils.js           ← Neosatsu-specific parsing utilities
      pathUtils.js               ← Filesystem path helpers
      queueManager.js            ← Background task queue (resumable on restart)
      scrapeHelper.js            ← Network fetch helpers with CF-bypass support
      stringUtils.js             ← Stateless string transformation functions
      tempFileCleanupWorker.js   ← Orphaned temp-file sweep worker
    views/                       ← Server-rendered HTML views (if any)
  server-prod.js                 ← Production entry point (enables productionSilent logger)
```

---

## Project: Wibuflix Backend (`samehadaku-scraper/`)

### Overview

- **Runtime**: Node.js (ES Modules)
- **Database**: MongoDB via Mongoose
- **Storage**: Azure Blob Storage
- **Browser Automation**: Puppeteer with stealth plugin and a managed browser pool
- **Transcoding**: FFmpeg for HLS `.ts` segment generation
- **Function**: Multi-provider VOD backend. Scrapes anime episode pages from external anime sites, extracts raw video URLs via provider-specific extractors, transcodes to HLS via FFmpeg, and uploads `.ts` segments + `playlist.m3u8` to Azure Blob Storage.

### Mandatory Pre-Edit Protocol

> **The agent must never make structural assumptions about this project without first inspecting existing source files.**

Before modifying, refactoring, or extending any backend module, the agent **must** perform the following steps in order:

1. Scan `src/` recursively to map all existing modules and their locations.
2. Read the relevant scraper under `src/services/scrapers/` to understand site-specific HTML extraction patterns.
3. Read `src/puppeteer/browserPool.js` and `src/puppeteer/pool.js` to understand how Puppeteer page slots are acquired and released.
4. Read `src/services/stream/blobStorageService.js` to understand container client setup, blob path conventions, and environment variable sources.
5. Read `src/services/stream/azureSegmentUploader.js` to understand the staged segment upload contract.
6. Read `src/services/extractors/videoExtractor.js` and relevant provider file under `src/services/extractors/providers/` for the affected video host.
7. Only after completing the above inspection may the agent propose or apply changes.

Failure to follow this inspection protocol before editing is a violation of this configuration.

### Module Responsibility Contracts

| Module Path | Sole Responsibility |
|---|---|
| `src/config/db.js` | Initialize and export the MongoDB connection |
| `src/config/providerUrls.js` | SSOT for all provider base URLs, catalog URLs, series path patterns, and domain keywords |
| `src/services/scrapers/*.js` | Extract episode lists and metadata from one specific external anime site |
| `src/services/extractors/videoExtractor.js` | Dispatch to the correct provider extractor based on detected URL domain |
| `src/services/extractors/providers/*.js` | Extract a direct video URL from one specific video hosting provider |
| `src/services/stream/blobStorageService.js` | Azure SDK instantiation, container client lifecycle, blob path formatting, upload status checks |
| `src/services/stream/azureSegmentUploader.js` | Write `.ts` segments and `.m3u8` files to Azure Blob Storage |
| `src/services/stream/downloaderClient.js` | Fetch HLS manifests and segments from source provider URLs |
| `src/services/stream/ffmpegStreamService.js` | Spawn and manage FFmpeg child processes for HLS transcoding |
| `src/services/stream/hlsTranscoder.js` | Orchestrate the full transcode-then-upload pipeline |
| `src/services/stream/streamStateStore.js` | In-memory caches for upload status and upload progress |
| `src/services/stream/uploadProgressService.js` | Lifecycle management: tracking active uploads, cancellation, progress reporting |
| `src/services/stream/streamFailoverService.js` | Detect stream failures and switch to alternate sources |
| `src/services/metadata/jikan.js` | Fetch and normalize anime metadata from the Jikan (MAL) API |
| `src/services/metadata/tmdb.js` | Fetch and normalize anime metadata from the TMDB API |
| `src/services/ProviderRegistry.js` | Register and resolve scraper modules by provider ID at runtime |
| `src/services/animeOrchestrator.js` | Aggregate episode data from multiple service calls with LRU caching |
| `src/puppeteer/browserPool.js` | Puppeteer browser instance creation, page pool, CF-bypass refresh |
| `src/puppeteer/pool.js` | Public interface for acquiring and releasing Puppeteer page slots |
| `src/puppeteer/cookieSessionStore.js` | Store and retrieve Cloudflare session cookies for Puppeteer |
| `src/puppeteer/concurrencyGuard.js` | Prevent concurrent over-use of Puppeteer page resources |
| `src/middlewares/errorHandler.js` | Express global error handler |
| `src/middlewares/urlValidator.js` | SSRF protection middleware |
| `src/jobs/scheduler.js` | Schedule and register background cron jobs |
| `src/sync/*.js` | Per-provider sync workers that pull updated anime/episode data into MongoDB |
| `src/utils/scrapeHelper.js` | HTTP fetch with Cloudflare bypass, retry, and Puppeteer fallback |
| `src/utils/kuronimeDecryptor.js` | Kuronime-specific encrypted video source decryption |
| `src/utils/contractValidator.js` | Runtime validation of scraper output against expected data contracts |
| `src/utils/queueManager.js` | Persistent background task queue with restart-resume support |
| `src/utils/logger.js` | Logging utility with productionSilent mode |
| `src/utils/stringUtils.js` | Stateless string transformation functions |
| `src/utils/animeMatcher.js` | Fuzzy title matching between scraped data and DB entries |

### Azure Blob Storage Constraints

- Azure SDK (`BlobServiceClient`) must only be instantiated in `src/services/stream/blobStorageService.js`.
- `AZURE_STORAGE_CONNECTION_STRING` and `AZURE_STORAGE_CONTAINER_NAME` must be sourced exclusively from environment variables — never hardcoded.
- Blob path construction (`seriesSlug/episodeSlug/filename`) is owned by `blobStorageService.js`. No other file may invent or redefine this convention.
- The `containerClient` singleton exported from `blobStorageService.js` is the only Azure client reference permitted across the codebase.
- Upload retry and staged-upload logic belongs in `azureSegmentUploader.js`.

### Scraping Constraints

- Each file in `src/services/scrapers/` targets exactly one external source domain.
- Each file in `src/services/extractors/providers/` handles exactly one video hosting provider.
- Network fetch calls (`axios`, `fetch`, Puppeteer page navigation) must not appear outside of `src/services/scrapers/`, `src/services/extractors/`, `src/puppeteer/`, and `src/utils/scrapeHelper.js`.
- Provider base URLs must be defined in `src/config/providerUrls.js` — never inlined inside scraper files.
- All scraper output must be a normalized, typed object. Raw HTML, unstructured strings, or cheerio objects must never be passed downstream.

### Puppeteer Constraints

- Browser instance creation and all page-level configuration live exclusively in `src/puppeteer/browserPool.js`.
- External callers must acquire page slots only through `src/puppeteer/pool.js` — never by importing from `browserPool.js` directly.
- Cloudflare cookie state is managed exclusively by `src/puppeteer/cookieSessionStore.js`.
- Puppeteer imports must not appear in any file outside the `src/puppeteer/` directory.

---

## Project: Wibuflix Frontend (`wibuflix-app/`)

### Overview

- **Framework**: React
- **Function**: Client-facing application for browsing and streaming VOD content served from the Wibuflix backend.

### Module Responsibility Contracts

| Module Path | Sole Responsibility |
|---|---|
| `src/components/` | Render UI; receive data via props; emit events via callbacks |
| `src/pages/` | Compose components; manage page-level layout; handle routing params |
| `src/hooks/` | Encapsulate data fetching, caching, and stateful side effects |
| `src/api/` | Define typed API client functions; map backend endpoints to JS calls |
| `src/utils/` | Stateless helper functions (formatters, validators, transformers) |
| `src/config/` | Export environment-derived constants and feature flags |

### React Component Constraints

- Components must not contain `fetch`, `axios`, or any direct API call logic.
- All data fetching must be delegated to custom hooks in `src/hooks/`.
- All API endpoint calls must be defined in `src/api/` and imported by hooks.
- Components must not import directly from `src/api/`.
- Side effects inside components are limited to UI concerns (focus management, animations, DOM refs).

---

## Cross-Cutting Rules

### Dependency Direction (Backend)

```
routes       -> controllers
controllers  -> services
services     -> models
services     -> config
services     -> utils
puppeteer    -> config
puppeteer    -> utils
sync         -> services
sync         -> utils
utils        <- (imported by any layer; never imports from layers above it)
```

### Dependency Direction (Frontend)

```
pages  -> components
pages  -> hooks
hooks  -> api
api    -> config
utils  <- (imported by any layer; never imports from other layers)
```

No layer may import from a layer above it in its respective hierarchy.

### File Naming

- Use `camelCase` for all JavaScript/TypeScript source files.
- Scraper files must be named after their target source (e.g., `kuronimeScraper.js`, `samehadakuScraper.js`).
- Extractor provider files must be named after the video host (e.g., `acefile.js`, `gdrive.js`).
- Uploader and stream-service files must be named after their specific function (e.g., `azureSegmentUploader.js`, `hlsTranscoder.js`).
- React component files must use `PascalCase` (e.g., `VideoCard.jsx`).
- Sync worker files must be named after their provider target (e.g., `kuronime_sync.js`).

### Refactoring Trigger Conditions

The agent must flag and refactor a file if any of the following conditions are met:

- A file imports from more than two distinct concern domains.
- A file exports more than one primary function or class that serves a different domain.
- A file contains both I/O logic (network, disk) and transformation/business logic.
- A scraper file contains upload logic, or an uploader file contains scraping logic.
- A Puppeteer file contains scraping HTML-parsing logic (parsing belongs in scrapers).
- A stream service file contains provider URL construction (that belongs in `config/providerUrls.js`).

### Forbidden Practices (All Projects)

- Hardcoded provider URLs, credentials, container names, or domain strings outside of config files.
- `console.log` left in production code paths without routing through `src/utils/logger.js`.
- Anonymous default exports that obscure module purpose.
- Circular dependencies between modules.
- Catching errors silently (empty `catch` blocks).
- Instantiating `BlobServiceClient` outside of `src/services/stream/blobStorageService.js`.
- Importing `puppeteer` or `puppeteer-extra` outside of `src/puppeteer/`.

---

## Mandatory Git Commit Protocol

> [!IMPORTANT]
> **Every completed task must end with a git commit. No exceptions.**

This ensures every change is a revertable checkpoint. If a deployment or runtime regression is detected, the last known-good state can be restored immediately with `git revert` or `git checkout`.

### Commit Trigger Conditions

The agent must stage and commit after **any** of the following:

- A new file is created.
- An existing file is modified.
- A file is deleted or renamed.
- A refactor is completed (even if behavior is unchanged).
- A bug is fixed.
- A dependency is added or removed (`package.json` changed).

### Commit Sequence

After completing a task and verifying the server starts cleanly, the agent must run:

```bash
git add -A
git commit -m "<type>(<scope>): <concise description>"
```

### Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Use When |
|---|---|
| `feat` | A new feature or capability is added |
| `fix` | A bug or incorrect behavior is corrected |
| `refactor` | Code is restructured without behavior change |
| `chore` | Tooling, config, or non-source changes |
| `docs` | Documentation or comments only |

**Scope** must be the primary file or module changed (e.g., `scheduler`, `queueManager`, `hlsTranscoder`).

**Examples:**
```
refactor(scheduler): delegate stale temp cleanup to tempFileCleanupWorker
fix(queueManager): replace priority-as-retryCount hack with explicit retryCount field
feat(blobStorageService): add checkUploadStatusWithFallback for multi-slug lookup
```

### Rules

- Never batch unrelated changes into a single commit.
- One logical change = one commit.
- If a task touches multiple files for the same concern (e.g., moving a function between modules), that is one commit.
- If a task touches files for different concerns, split into separate commits.
- For backend changes, do not commit without first verifying the server starts (`node server-prod.js` or `node src/server.js`).
- For frontend changes, do not worry about checking if everything works in the app. All you need to do before committing is verify types compile by running `npx tsc --noEmit` in the frontend directory.
- Never force-push to `main` or `master`.
