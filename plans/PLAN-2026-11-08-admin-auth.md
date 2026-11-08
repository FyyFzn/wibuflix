# PLAN: Admin Panel Password-Based Session Authentication

## 1. Goal and Scope

Implement password-based session authentication for all Wibuflix Admin Panel routes (`/admin`, `/api/admin/*`, and administrative maintenance endpoints). Protect all admin UI portals and API endpoints against unauthenticated access.

In scope:
- Install `express-session` and `express-rate-limit`.
- Create `src/middlewares/adminAuthMiddleware.js` for request-type-aware authentication guard.
- Create `src/views/admin/login.html` using existing GitHub dark theme styling.
- Update `src/routes/admin.js` with `GET /admin/login`, `POST /admin/login` (brute-force rate limited), and `GET /admin/logout`.
- Update `src/server.js` to register `express-session` middleware before routes.
- Configure Azure App Service settings `SESSION_SECRET` and `ADMIN_PASSWORD` via Azure CLI.
- Push changes to trigger automated CI/CD deployment.

Out of scope:
- User accounts, multi-user roles, database models, or permission tables.
- `src/middlewares/authMiddleware.js` (syncAuthMiddleware) or history sync routes (`/api/history/*`).
- Modifying existing admin route paths (all URLs and bookmarks stay identical).
- Any dependencies beyond `express-session` and `express-rate-limit`.
- Infrastructure, Docker, or CI/CD workflow configuration files.

Done means:
- Visiting `/admin` or `/api/admin/logs` in a browser without an active session redirects (HTTP 302) to `/admin/login`.
- Sending requests to `/api/admin/*` or maintenance endpoints without an active session returns HTTP 401 JSON `{ "status": "error", "message": "Unauthorized" }`.
- Submitting the correct password to `/admin/login` creates a session (`req.session.isAdmin = true`) and redirects to `/admin`.
- Submitting an incorrect password re-renders `/admin/login` with an error message and HTTP 401 status.
- Excessive failed login attempts (> 10 per 15 minutes per IP) trigger HTTP 429 rate limit response.
- Visiting `/admin/logout` destroys the session and redirects to `/admin/login`.
- Server starts cleanly in production with `node src/server.js`.
- Azure App Service receives `SESSION_SECRET` and `ADMIN_PASSWORD`.

---

## 2. Executor Rules

- Follow phases and steps in order, one at a time.
- Commit after each step: `git add -A && git commit -m "<type>(<scope>): <step description>"`.
- If the code does not match what a step describes, STOP and report the mismatch. Do not improvise or fix adjacent things.
- Do not add dependencies, rename things, or change behavior outside the step.
- Run the step's verification before moving on. If it fails, stop and report.
- For backend steps: verify server starts with `node src/server.js` before committing.
- For frontend steps: verify types compile with `npx tsc --noEmit` before committing.
- Do NOT update any skill file. Skill updates are handled by the senior model after verification.

---

## 3. Findings

| ID | Status | File:Line | Description |
|---|---|---|---|
| F1 | VERIFIED | `src/routes/admin.js:12-34` | All admin UI routes (`/admin`, `/api/admin/logs`) and API routes (`/api/admin/*`, `/api/cache-clear`, `/api/force-sync`, `/api/retry-enrich`, `/api/factory-reset`) currently have zero authentication guards. |
| F2 | VERIFIED | `src/server.js:67` | `app.set('trust proxy', true)` is enabled; required for secure cookies and accurate client IP detection behind Azure proxy. |
| F3 | VERIFIED | `src/server.js:71-72` | `express.json()` and `express.urlencoded({ extended: true })` are mounted; handles URL-encoded POST submissions from HTML login forms. |
| F4 | VERIFIED | `src/server.js:80-86` | `adminRouter` is mounted at root `/`. Middleware must NOT be applied unscoped inside `admin.js` to avoid leaking auth checks into `/health` or `historyRouter`. |
| F5 | VERIFIED | `src/middlewares/authMiddleware.js:1-14` | Only exports `syncAuthMiddleware` for `x-sync-token` verification. Single Responsibility requires new admin session middleware in a dedicated file. |
| F6 | VERIFIED | `src/views/admin/portal.html:8-19` | Defines `:root` CSS variables for the dark theme (`--bg-primary: #0d1117`, `--bg-card: #161b22`, `--border-color: #30363d`, etc.). |

---

## 4. Phases and Steps

### Phase 0 — Commit Clean State & Plan File

**Step 0 — Commit the plan file**
- **Files:** `plans/PLAN-2026-11-08-admin-auth.md`
- **Change:** Stage and commit the plan file alone before any source modifications.
- **Verify:**
  ```bash
  git status
  git log --oneline -1
  ```
  Expected: Clean working tree, HEAD commit points to `docs(plans): add PLAN-2026-11-08-admin-auth.md`.
- **Commit message:** `docs(plans): add PLAN-2026-11-08-admin-auth.md`
- **Rollback:** `git reset --soft HEAD~1`

---

### Phase 1 — Install Dependencies

**Step 1 — Install express-session and express-rate-limit**
- **Files:** `package.json`, `package-lock.json`
- **Change:** Install production dependencies:
  ```bash
  npm install express-session express-rate-limit
  ```
- **Traps to avoid:** Do not install any additional packages (such as `connect-mongo`, `passport`, `cookie-parser`). `express-session` handles cookies directly.
- **Verify:**
  ```bash
  node -e "import('express-session').then(() => import('express-rate-limit')).then(() => console.log('DEPS_OK'))"
  ```
  Expected output: `DEPS_OK`.
- **Commit message:** `chore(deps): install express-session and express-rate-limit`
- **Rollback:** `npm uninstall express-session express-rate-limit && git checkout package*.json`

---

### Phase 2 — Create Admin Auth Middleware

**Step 2 — Create `src/middlewares/adminAuthMiddleware.js`**
- **Files:** `src/middlewares/adminAuthMiddleware.js` (new file)
- **Change:** Create middleware module with single responsibility: verify active admin session and branch response based on request type (HTML vs API).
- **Line endings:** CRLF.
- **All code comments:** Indonesian.

Verbatim file content:
```js
// ============================================================
// MIDDLEWARE: ADMIN SESSION AUTHENTICATION GUARD
// ============================================================

/**
 * Middleware untuk memverifikasi session autentikasi admin.
 * Memeriksa apakah session aktif dan memiliki flag isAdmin === true.
 * - Request browser HTML (Accept: text/html): redirect ke /admin/login
 * - Request API / Fetch / JSON: kembalikan response HTTP 401 JSON
 */
export function adminAuthMiddleware(req, res, next) {
    if (req.session && req.session.isAdmin === true) {
        return next();
    }

    // Deteksi apakah pemanggil meminta halaman HTML (browser navigation)
    const acceptsHtml = req.accepts(['html', 'json']) === 'html' ||
                        (req.headers.accept && req.headers.accept.includes('text/html'));

    if (acceptsHtml) {
        return res.redirect('/admin/login');
    }

    return res.status(401).json({
        status: 'error',
        message: 'Unauthorized'
    });
}
```

- **Traps to avoid:**
  - Do not use `req.path.startsWith('/api')` alone; browser navigation to `/api/admin/logs` expects HTML redirect, not a raw JSON 401 error. Checking `req.accepts(['html', 'json']) === 'html'` handles both UI portal endpoints correctly.
  - Do not modify or import `syncAuthMiddleware`.
- **Verify:**
  Run verification script:
  ```bash
  node -e "
  import { adminAuthMiddleware } from './src/middlewares/adminAuthMiddleware.js';
  import assert from 'assert';

  // 1. Unauthenticated HTML request -> Redirect
  let redirected = null;
  adminAuthMiddleware(
      { session: {}, accepts: () => 'html', headers: { accept: 'text/html' } },
      { redirect: (url) => { redirected = url; } },
      () => { throw new Error('Should not call next'); }
  );
  assert.strictEqual(redirected, '/admin/login', 'Harus redirect ke /admin/login');

  // 2. Unauthenticated API request -> 401 JSON
  let statusCode = null, jsonBody = null;
  adminAuthMiddleware(
      { session: {}, accepts: () => 'json', headers: { accept: 'application/json' } },
      { status: (c) => { statusCode = c; return { json: (b) => { jsonBody = b; } }; } },
      () => { throw new Error('Should not call next'); }
  );
  assert.strictEqual(statusCode, 401, 'Harus status 401');
  assert.strictEqual(jsonBody.message, 'Unauthorized', 'Pesan harus Unauthorized');

  // 3. Authenticated request -> next()
  let nextCalled = false;
  adminAuthMiddleware(
      { session: { isAdmin: true } },
      {},
      () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, true, 'Harus memanggil next()');
  console.log('MIDDLEWARE_TEST_PASSED');
  "
  ```
  Expected output: `MIDDLEWARE_TEST_PASSED`.
- **Commit message:** `feat(middleware): add adminAuthMiddleware for session-based protection`
- **Rollback:** `git rm src/middlewares/adminAuthMiddleware.js`

---

### Phase 3 — Create Login View

**Step 3 — Create `src/views/admin/login.html`**
- **Files:** `src/views/admin/login.html` (new file)
- **Change:** Create clean, dark-themed HTML login page matching CSS variables from `portal.html`.
- **Line endings:** CRLF.

Verbatim file content:
```html
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WibuFlix Admin Login</title>
    <style>
        :root {
            --bg-primary: #0d1117;
            --bg-card: #161b22;
            --border-color: #30363d;
            --text-main: #c9d1d9;
            --text-muted: #8b949e;
            --accent-blue: #1f6feb;
            --accent-green: #238636;
            --accent-red: #da3633;
            --accent-yellow: #d29922;
            --accent-purple: #8957e5;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: var(--bg-primary);
            color: var(--text-main);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
        }
        .login-card {
            background-color: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 32px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        }
        .login-header {
            text-align: center;
            margin-bottom: 24px;
        }
        .login-header h1 {
            font-size: 20px;
            color: #fff;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }
        .login-header p {
            font-size: 13px;
            color: var(--text-muted);
        }
        .error-banner {
            background-color: rgba(218, 54, 51, 0.15);
            border: 1px solid var(--accent-red);
            color: #ff7b72;
            padding: 10px 14px;
            border-radius: 6px;
            font-size: 13px;
            margin-bottom: 20px;
            line-height: 1.4;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-main);
            margin-bottom: 8px;
        }
        input[type="password"] {
            width: 100%;
            background-color: #0d1117;
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: #fff;
            padding: 10px 14px;
            font-size: 14px;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        input[type="password"]:focus {
            outline: none;
            border-color: var(--accent-blue);
            box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.3);
        }
        button.btn-login {
            width: 100%;
            background-color: var(--accent-blue);
            border: 1px solid var(--accent-blue);
            color: #fff;
            padding: 11px 16px;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: background-color 0.15s, border-color 0.15s;
        }
        button.btn-login:hover {
            background-color: #388bfd;
            border-color: #388bfd;
        }
        button.btn-login:active {
            background-color: #1a56be;
        }
        .footer-note {
            text-align: center;
            margin-top: 20px;
            font-size: 11px;
            color: var(--text-muted);
        }
    </style>
</head>
<body>
    <div class="login-card">
        <div class="login-header">
            <h1>🚀 WIBUFLIX ADMIN</h1>
            <p>Masukkan kata sandi admin untuk mengakses Command Center.</p>
        </div>

        <!--ERROR_BANNER-->

        <form method="POST" action="/admin/login">
            <div class="form-group">
                <label for="password">Kata Sandi Admin</label>
                <input type="password" id="password" name="password" placeholder="••••••••••••" required autofocus autocomplete="current-password" />
            </div>
            <button type="submit" class="btn-login">Masuk ke Command Center ➔</button>
        </form>

        <div class="footer-note">
            Wibuflix Infrastructure Management &bull; Akses Terbatas
        </div>
    </div>
</body>
</html>
```

- **Traps to avoid:**
  - Must include placeholder tag `<!--ERROR_BANNER-->` verbatim. The route handler uses string replacement on this tag to inject failure banners.
- **Verify:**
  ```bash
  node -e "
  import fs from 'fs';
  const html = fs.readFileSync('src/views/admin/login.html', 'utf8');
  if (!html.includes('<!--ERROR_BANNER-->')) throw new Error('Missing error placeholder');
  if (!html.includes('action=\"/admin/login\"')) throw new Error('Missing form action');
  if (!html.includes('name=\"password\"')) throw new Error('Missing password field');
  console.log('LOGIN_HTML_VERIFIED');
  "
  ```
  Expected output: `LOGIN_HTML_VERIFIED`.
- **Commit message:** `feat(views): create dark-themed admin login page`
- **Rollback:** `git rm src/views/admin/login.html`

---

### Phase 4 — Update Admin Router

**Step 4 — Wire Auth Routes and Middleware in `src/routes/admin.js`**
- **Files:** `src/routes/admin.js`
- **Change:**
  1. Import `fs`, `path`, `fileURLToPath`, `rateLimit`, and `adminAuthMiddleware`.
  2. Implement `renderLoginPage(error)` helper function.
  3. Configure `loginLimiter` (max 10 attempts per 15 min per IP).
  4. Register public routes:
     - `GET /admin/login` (redirects to `/admin` if already authenticated).
     - `POST /admin/login` (checks `req.body.password === process.env.ADMIN_PASSWORD`, sets `req.session.isAdmin = true`, calls `req.session.save()`, redirects to `/admin`; re-renders on failure with 401).
     - `GET /admin/logout` (destroys session, clears cookie, redirects to `/admin/login`).
  5. Apply `adminAuthMiddleware` directly to all protected admin and maintenance routes.
- **Line endings:** CRLF.
- **All code comments:** Indonesian.

Verbatim file content for `src/routes/admin.js`:
```js
// ============================================================
// ROUTER: ADMIN ROUTES (THIN ROUTER / NO GOD CODE)
// ============================================================

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import rateLimit from 'express-rate-limit';
import * as adminCtrl from '../controllers/adminController.js';
import { handleAiChat } from '../controllers/aiAdminController.js';
import { adminAuthMiddleware } from '../middlewares/adminAuthMiddleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Helper untuk menyajikan halaman login.html dengan pesan error (jika ada)
function renderLoginPage(error = '') {
    const filePath = path.join(__dirname, '../views/admin/login.html');
    let html = fs.readFileSync(filePath, 'utf-8');
    const errorHtml = error ? `<div class="error-banner">⚠️ ${error}</div>` : '';
    return html.replace('<!--ERROR_BANNER-->', errorHtml);
}

// Rate limiter untuk proteksi brute-force login admin (maksimal 10 percobaan per 15 menit per IP)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Terlalu banyak percobaan login yang gagal. Silakan coba lagi setelah 15 menit.',
    handler: (req, res, next, options) => {
        res.status(429).send(renderLoginPage(options.message));
    }
});

// ============================================================
// 0. AUTHENTICATION ROUTES (PUBLIC)
// ============================================================

// Form Login Admin (GET /admin/login)
router.get('/admin/login', (req, res) => {
    if (req.session && req.session.isAdmin) {
        return res.redirect('/admin');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLoginPage());
});

// Proses Autentikasi Login (POST /admin/login)
router.post('/admin/login', loginLimiter, (req, res) => {
    const { password } = req.body || {};
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
        console.error('❌ [AdminAuth] ADMIN_PASSWORD belum dikonfigurasi di environment!');
        res.status(500);
        return res.send(renderLoginPage('Konfigurasi server bermasalah (ADMIN_PASSWORD belum diset).'));
    }

    if (password === adminPassword) {
        req.session.isAdmin = true;
        return req.session.save((err) => {
            if (err) {
                console.error('❌ [AdminAuth] Gagal menyimpan session:', err);
                return res.status(500).send(renderLoginPage('Gagal membuat sesi login.'));
            }
            res.redirect('/admin');
        });
    }

    res.status(401);
    res.send(renderLoginPage('Kata sandi salah. Silakan coba lagi.'));
});

// Logout Admin (GET /admin/logout)
router.get('/admin/logout', (req, res) => {
    if (req.session) {
        req.session.destroy((err) => {
            if (err) {
                console.error('❌ [AdminAuth] Gagal menghapus session:', err);
            }
            res.clearCookie('connect.sid');
            res.redirect('/admin/login');
        });
    } else {
        res.redirect('/admin/login');
    }
});

// ============================================================
// 1. UI Portals & Live Stream (PROTECTED)
// ============================================================
router.get(['/admin', '/api/admin'], adminAuthMiddleware, adminCtrl.renderAdminPortal);
router.get('/api/admin/logs', adminAuthMiddleware, adminCtrl.renderLiveLogUI);
router.get('/api/admin/logs/raw', adminAuthMiddleware, adminCtrl.getRawLogs);
router.get('/api/admin/logs/ai-analyze', adminAuthMiddleware, adminCtrl.analyzeLogsAi);
router.post('/api/admin/logs/test-telegram', adminAuthMiddleware, adminCtrl.testTelegramAlert);

// ============================================================
// 2. System Maintenance & Cache (PROTECTED)
// ============================================================
router.get('/api/cache-clear', adminAuthMiddleware, adminCtrl.clearMemoryCache);
router.get('/api/force-sync', adminAuthMiddleware, adminCtrl.triggerForceSync);
router.get('/api/retry-enrich', adminAuthMiddleware, adminCtrl.triggerRetryEnrich);
router.get('/api/factory-reset', adminAuthMiddleware, adminCtrl.triggerFactoryReset);

// ============================================================
// 3. Card Management & Merge Engine (PROTECTED)
// ============================================================
router.get('/api/admin/catalog-search', adminAuthMiddleware, adminCtrl.searchCatalogCards);
router.post('/api/admin/merge-anime', adminAuthMiddleware, adminCtrl.mergeAnimeCards);
router.post('/api/admin/force-mal-id', adminAuthMiddleware, adminCtrl.forceMalIdOnCard);
router.post('/api/admin/rename-anime', adminAuthMiddleware, adminCtrl.renameAnimeCard);
router.post('/api/admin/force-enrich-card', adminAuthMiddleware, adminCtrl.forceEnrichCards);
router.get('/api/admin/anime-details/:id', adminAuthMiddleware, adminCtrl.getAnimeDetails);
router.post('/api/admin/split-url', adminAuthMiddleware, adminCtrl.splitAnimeUrl);

// ============================================================
// 4. AI Assistant (PROTECTED)
// ============================================================
router.post('/api/admin/ai-chat', adminAuthMiddleware, handleAiChat);

export default router;
```

- **Traps to avoid:**
  - Call `req.session.save()` inside `POST /admin/login` before calling `res.redirect('/admin')`. Omitting `.save()` causes a race condition where the redirect request arrives before the session is committed to the session store.
  - Do not use global `router.use(adminAuthMiddleware)` without a path prefix; `adminRouter` is mounted at root `/` in `server.js` and an unscoped router-level middleware would intercept `/health` and `historyRouter`.
- **Verify:**
  Run syntax check:
  ```bash
  node -c src/routes/admin.js
  ```
  Expected output: No syntax error.
- **Commit message:** `feat(routes): secure admin routes with session auth and rate limiting`
- **Rollback:** `git checkout HEAD~1 -- src/routes/admin.js`

---

### Phase 5 — Wire Session Middleware in Server Entry

**Step 5 — Mount express-session in `src/server.js`**
- **Files:** `src/server.js`
- **Change:**
  1. Add `import session from 'express-session';` at the top imports.
  2. Wire `express-session` middleware immediately after `app.use(express.urlencoded({ extended: true }))` (around line 73) and BEFORE mounting any routers.
  3. Configure cookie options: `httpOnly: true`, `secure: process.env.NODE_ENV === 'production'`, `sameSite: 'lax'`, `maxAge: 24 * 60 * 60 * 1000`.
- **Line endings:** CRLF.

Diff in `src/server.js`:
```diff
@@ -15,6 +15,7 @@
 import express from 'express';
 import cors from 'cors';
+import session from 'express-session';
 import path from 'path';
 import { fileURLToPath } from 'url';
 import { backgroundQueue } from './utils/queueManager.js';
@@ -71,6 +72,17 @@
 app.use(express.json());
 app.use(express.urlencoded({ extended: true }));
 app.set('json spaces', 2);
+
+// Session Middleware untuk Admin Command Center
+app.use(session({
+    secret: process.env.SESSION_SECRET || 'wibuflix-session-secret-dev-random-key',
+    resave: false,
+    saveUninitialized: false,
+    cookie: {
+        httpOnly: true,
+        secure: process.env.NODE_ENV === 'production',
+        sameSite: 'lax',
+        maxAge: 24 * 60 * 60 * 1000 // Berlaku 24 jam
+    }
+}));
 
 // SSRF Protection Middleware
 app.use(ssrfMiddleware);
```

- **Traps to avoid:**
  - `session` must be mounted AFTER `express.urlencoded` (so request bodies are already parsed) and BEFORE `app.use(adminRouter)`.
  - Do NOT hardcode the production secret or password.
- **Verify:**
  Run server check:
  ```bash
  node -e "
  import('./src/server.js').then(() => {
      console.log('SERVER_LOADED_OK');
      process.exit(0);
  }).catch(err => {
      console.error(err);
      process.exit(1);
  });
  "
  ```
  Expected output: `SERVER_LOADED_OK` (or normal server start banner; exits cleanly with 0).
- **Commit message:** `feat(server): wire express-session middleware before routes`
- **Rollback:** `git checkout HEAD~1 -- src/server.js`

---

### Phase 6 — Set Azure App Service Configuration

**Step 6 — Set SESSION_SECRET and ADMIN_PASSWORD in Azure App Service**
- **Files:** No repository code files changed.
- **Change:** Push environment variables to Azure Web App `wibuflix` under resource group `wibuflix_group-b8bf`.
- **Commands:**
  1. Generate random 32-character hexadecimal string for `SESSION_SECRET`:
     ```bash
     HEX_SECRET=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
     echo "Generated secret length: ${#HEX_SECRET}"
     ```
  2. Apply settings via Azure CLI:
     ```bash
     az webapp config appsettings set \
       --name wibuflix \
       --resource-group wibuflix_group-b8bf \
       --settings SESSION_SECRET="$HEX_SECRET" ADMIN_PASSWORD="asdf0609"
     ```
- **Traps to avoid:** Do not echo or log the raw secret into public git commits or unencrypted log files.
- **Verify:**
  ```bash
  az webapp config appsettings list \
    --name wibuflix \
    --resource-group wibuflix_group-b8bf \
    --query "[?name=='SESSION_SECRET' || name=='ADMIN_PASSWORD'].name" \
    -o tsv
  ```
  Expected output:
  ```
  ADMIN_PASSWORD
  SESSION_SECRET
  ```
- **Rollback:**
  ```bash
  az webapp config appsettings delete --name wibuflix --resource-group wibuflix_group-b8bf --setting-names SESSION_SECRET ADMIN_PASSWORD
  ```

---

### Phase 6b — Add Logout Button to Admin Portal

**Step 6b — Add logout link to `src/views/admin/portal.html` header**
- **Files:** `src/views/admin/portal.html`
- **Change:** Add a logout anchor button in the existing header button row (line 384-387), after the Live Log UI button.
- **Line endings:** CRLF.

Exact change — inside the `<div style="display: flex; gap: 10px; align-items: center;">` at line 384, append after the existing `<button>` for Live Log UI:
```html
            <a href="/admin/logout" style="display:inline-flex;align-items:center;gap:6px;padding:7px 14px;background-color:rgba(218,54,51,0.15);border:1px solid var(--accent-red);color:#ff7b72;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;">🔒 Logout</a>
```

- **Verify:**
  ```bash
  node -e "
  import fs from 'fs';
  const html = fs.readFileSync('src/views/admin/portal.html', 'utf8');
  if (!html.includes('href=\"/admin/logout\"')) throw new Error('Missing logout link');
  console.log('LOGOUT_BTN_VERIFIED');
  "
  ```
  Expected output: `LOGOUT_BTN_VERIFIED`.
- **Commit message:** `feat(views): add logout button to admin portal header`
- **Rollback:** `git checkout HEAD~1 -- src/views/admin/portal.html`

---

### Phase 7 — Final Verification and Push to Main

**Step 7 — Comprehensive Local Test, Push to Main, and Deploy**
- **Files:** All modified files across Phases 1-5.
- **Change:** Run automated verification tests, ensure git status is clean, and push to `origin/main` to trigger automated GitHub Actions build and App Service redeploy.
- **Commands:**
  1. Run end-to-end admin auth test script:
     ```bash
     ADMIN_PASSWORD="testadminpassword" node -e "
     import express from 'express';
     import session from 'express-session';
     import adminRouter from './src/routes/admin.js';
     import assert from 'assert';

     const app = express();
     app.use(express.urlencoded({ extended: true }));
     app.use(express.json());
     app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false }));
     app.use(adminRouter);

     const server = app.listen(0, async () => {
         const port = server.address().port;
         const baseUrl = 'http://127.0.0.1:' + port;

         // 1. Unauthenticated HTML -> 302 to /admin/login
         const resHtml = await fetch(baseUrl + '/admin', { redirect: 'manual', headers: { 'Accept': 'text/html' } });
         assert.strictEqual(resHtml.status, 302);
         assert.strictEqual(resHtml.headers.get('location'), '/admin/login');

         // 2. Unauthenticated API -> 401 JSON
         const resApi = await fetch(baseUrl + '/api/admin/logs/raw', { headers: { 'Accept': 'application/json' } });
         assert.strictEqual(resApi.status, 401);
         const json = await resApi.json();
         assert.strictEqual(json.status, 'error');

         // 3. Failed Login -> 401 with error banner
         const resFail = await fetch(baseUrl + '/admin/login', {
             method: 'POST',
             headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
             body: 'password=wrongpassword'
         });
         assert.strictEqual(resFail.status, 401);
         const failHtml = await resFail.text();
         assert.ok(failHtml.includes('Kata sandi salah'));

         // 4. Successful Login -> 302 to /admin with Set-Cookie
         const resSuccess = await fetch(baseUrl + '/admin/login', {
             method: 'POST',
             redirect: 'manual',
             headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
             body: 'password=testadminpassword'
         });
         assert.strictEqual(resSuccess.status, 302);
         assert.strictEqual(resSuccess.headers.get('location'), '/admin');
         const cookie = resSuccess.headers.get('set-cookie');
         assert.ok(cookie, 'Harus mengembalikan cookie session');

         // 5. Authenticated HTML -> 200 OK
         const resAuth = await fetch(baseUrl + '/admin', {
             headers: { 'Cookie': cookie, 'Accept': 'text/html' }
         });
         assert.strictEqual(resAuth.status, 200);

         // 6. Logout -> 302 to /admin/login
         const resLogout = await fetch(baseUrl + '/admin/logout', {
             redirect: 'manual',
             headers: { 'Cookie': cookie }
         });
         assert.strictEqual(resLogout.status, 302);
         assert.strictEqual(resLogout.headers.get('location'), '/admin/login');

         console.log('✅ ALL ADMIN AUTH INTEGRATION CHECKS PASSED');
         server.close();
         process.exit(0);
     });
     "
     ```
  2. Verify git status and commit history:
     ```bash
     git status
     git log --oneline -7
     ```
  3. Push to `origin/main`:
     ```bash
     git push origin main
     ```
- **Verify:**
  - `git status` shows `nothing to commit, working tree clean`.
  - GitHub Actions starts deployment workflow for commit.
  - After deployment completes (~3-5 mins), test live URL:
    ```bash
    curl -I https://wibuflix.azurewebsites.net/admin
    ```
    Expected: `HTTP/1.1 302 Found` with `Location: /admin/login`.
- **Commit message:** No separate commit needed (pushing commits from Phases 0-5).
- **Rollback:** `git revert HEAD~4..HEAD && git push origin main`

---

## 5. Needs My Decision

None. All constraints, route requirements, credentials, and environmental targets are fully specified.

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Proxy SSL cookie dropping | Sessions lost on every request in Azure App Service | `trust proxy` is already `true` in `server.js`. `cookie.secure` is tied to `NODE_ENV === 'production'` and uses `sameSite: 'lax'`. |
| Session write race condition | Browser redirects to `/admin` before memory session write completes, causing immediate redirect loop back to `/admin/login` | Explicitly call `req.session.save(callback)` before calling `res.redirect('/admin')` in `POST /admin/login`. |
| Unintended route blocking | Non-admin routes (like `/health` or history routes) accidentally blocked | `adminAuthMiddleware` is attached explicitly to each individual admin route in `src/routes/admin.js`, rather than an unscoped router-level `use()`. |
| Memory leak from session store | In-memory session store (`MemoryStore`) growing indefinitely | `saveUninitialized: false` ensures sessions are only created for authenticated administrators, keeping session count tiny (single digits). |

---

## 7. Noticed but Out of Scope

1. `portal.html` does not currently feature a visible "Logout" link in its top navigation bar (though `/admin/logout` functions directly when visited).
2. Existing test files `provider_accessibility_contract.test.js` and `provider_url_completeness.test.js` fail due to hardcoded expectation of 7 providers instead of the currently configured 9 providers.

---

## 8. After Execution

When all steps are committed, report back to the senior model (not the executor):
- State which plan file was executed.
- List any steps that were PARTIAL or had to deviate.
- Do not update the wibuflix skill or any skill file.
The senior model will run verify-plan, confirm correctness, then update the skill.
