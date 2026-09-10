/**
 * Middleware penanganan error global untuk Express.
 * Menggantikan pengulangan try-catch di setiap rute controller.
 */
export function errorHandler(err, req, res, next) {
    console.error(`[GlobalError] ${req.method} ${req.url} ->`, err.message);

    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
        status: 'error',
        message: err.message || 'Terjadi kesalahan pada server.',
        error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
}

/**
 * Membungkus async route handler sehingga error yang di-throw otomatis
 * diteruskan ke errorHandler global tanpa perlu menulis try-catch di setiap controller.
 * @param {Function} fn - Async route handler (req, res, next) => Promise
 */
export function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
