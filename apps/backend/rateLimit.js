/**
 * In-memory sliding-window rate limiter.
 *
 * Each key keeps the timestamps of its requests inside the last `windowMs`; a request
 * is allowed while fewer than `limit` remain in the window. Unlike a fixed window this
 * never lets 2x `limit` through across a window boundary.
 *
 * Sets the IETF draft headers on every response:
 *   RateLimit-Limit     requests allowed per window
 *   RateLimit-Remaining requests left in the current window
 *   RateLimit-Reset     seconds until the oldest counted request leaves the window
 *                       (i.e. until Remaining next increases)
 *   RateLimit-Policy    "<limit>;w=<window seconds>"
 * plus Retry-After on a 429.
 *
 * State is per process: behind several API instances each one enforces its own limit.
 */
const createRateLimiter = ({
    windowMs,
    limit,
    keyGenerator,
    message = "Too many requests, please retry later",
    now = Date.now,
}) => {
    const hits = new Map();

    const prune = (timestamps, at) => {
        const windowStart = at - windowMs;
        let expired = 0;
        while (expired < timestamps.length && timestamps[expired] <= windowStart) expired++;
        if (expired) timestamps.splice(0, expired);
    };

    const middleware = (req, res, next) => {
        const key = keyGenerator(req);
        if (key === undefined || key === null) return next();

        const at = now();
        let timestamps = hits.get(key);
        if (!timestamps) {
            timestamps = [];
            hits.set(key, timestamps);
        }
        prune(timestamps, at);

        const allowed = timestamps.length < limit;
        if (allowed) timestamps.push(at);

        const resetSeconds = timestamps.length ? Math.max(0, Math.ceil((timestamps[0] + windowMs - at) / 1000)) : 0;
        res.set({
            'RateLimit-Limit': String(limit),
            'RateLimit-Remaining': String(Math.max(0, limit - timestamps.length)),
            'RateLimit-Reset': String(resetSeconds),
            'RateLimit-Policy': `${limit};w=${Math.ceil(windowMs / 1000)}`,
        });

        if (!allowed) {
            res.set('Retry-After', String(Math.max(1, resetSeconds)));
            return res.status(429).json({ error: message });
        }
        next();
    };

    // Drop keys with no requests left in the window so idle clients do not accumulate
    const sweep = () => {
        const at = now();
        for (const [key, timestamps] of hits) {
            prune(timestamps, at);
            if (!timestamps.length) hits.delete(key);
        }
    };
    const sweepTimer = setInterval(sweep, windowMs);
    sweepTimer.unref?.();

    middleware.reset = () => hits.clear();
    middleware.sweep = sweep;
    middleware.stop = () => clearInterval(sweepTimer);
    return middleware;
};

module.exports = { createRateLimiter };
