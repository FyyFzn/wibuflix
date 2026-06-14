/**
 * Middleware penanganan error global untuk Express
 * Menggantikan pengulangan try-catch di setiap rute controller
 */
export function errorHandler(err, req, res, next) {
    console.error(`[GlobalError] ${req.method} ${req.url} ->`, err.message);

    // Kirimkan response JSON yang terstruktur
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
        status: 'error',
        message: err.message || 'Terjadi kesalahan pada server.',
        error: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
}
