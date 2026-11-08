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
