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
