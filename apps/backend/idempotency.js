const crypto = require('crypto');

// How long a completed idempotency key replays its stored response
const IDEMPOTENCY_KEY_TTL_SECONDS = Number(process.env.IDEMPOTENCY_KEY_TTL_SECONDS) || 24 * 60 * 60;
// After this long an in_progress claim is presumed abandoned (crashed process) and may be retried
const IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS = Number(process.env.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS) || 5 * 60;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

// Postgres foreign key violation: the merchant scoping the key does not exist
const isForeignKeyError = (error) => error?.code === '23503';

// Recursively sorts object keys so semantically identical bodies hash identically
const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((acc, key) => {
            acc[key] = canonicalize(value[key]);
            return acc;
        }, {});
    }
    return value;
};

const hashRequestBody = (body) =>
    crypto.createHash('sha256').update(JSON.stringify(canonicalize(body ?? {}))).digest('hex');

// Returns { key } (null when the header is absent) or { error } for a malformed header
const readIdempotencyKey = (req) => {
    const raw = req.get('Idempotency-Key');
    if (raw === undefined) return { key: null };
    const key = raw.trim();
    if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        return { error: `Idempotency-Key header must be between 1 and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` };
    }
    return { key };
};

// Runs a handler returning { status, body }, converting thrown errors into a 500 result
const runSafely = async (handler, label) => {
    try {
        return await handler();
    } catch (err) {
        console.error(`Error ${label}:`, err);
        return { status: 500, body: { error: err.message } };
    }
};

// A result is retryable with the same key when it is a server error or explicitly
// marked transient (e.g. lock contention); everything else is replayed as-is.
const isRetryableResult = (result) => result.retryable === true || result.status >= 500;

/**
 * Executes `handler` at most once per (merchant, Idempotency-Key).
 *
 * - No header: the handler simply runs.
 * - First request: the key is claimed as in_progress, the handler runs and its
 *   response is stored as completed (or failed, which lets a retry run it again).
 * - Retry of a completed request: the stored response is replayed.
 * - Concurrent duplicate while the first is still running: 409.
 * - Same key reused with a different path or body: 422.
 *
 * Keys are scoped per merchant. `resolveMerchant` is only called when a key is
 * present and returns { merchantId } or an error result such as { status: 404, body }.
 * The handler must return { status, body } rather than writing to `res`.
 */
const executeIdempotently = async ({ supabase, req, resolveMerchant, label }, handler) => {
    const { key, error: keyError } = readIdempotencyKey(req);
    if (keyError) return { status: 400, body: { error: keyError } };
    if (!key) return runSafely(handler, label);

    const scope = await runSafely(resolveMerchant, label);
    if (!scope.merchantId) return scope;
    const { merchantId } = scope;

    const requestPath = req.path;
    const requestHash = hashRequestBody(req.body);

    const { data, error: claimError } = await supabase.rpc('claim_idempotency_key', {
        p_merchant_id: merchantId,
        p_key: key,
        p_request_path: requestPath,
        p_request_hash: requestHash,
        p_ttl_seconds: IDEMPOTENCY_KEY_TTL_SECONDS,
        p_in_progress_timeout_seconds: IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS,
    });
    if (isForeignKeyError(claimError)) return { status: 404, body: { error: "Merchant not found" } };
    if (claimError) {
        console.error(`Error claiming idempotency key for ${label}:`, claimError);
        return { status: 500, body: { error: claimError.message } };
    }

    const { claimed, record } = data;

    if (!claimed) {
        if (record.request_path !== requestPath || record.request_hash !== requestHash) {
            return {
                status: 422,
                body: { error: "Idempotency-Key has already been used with a different request" },
            };
        }
        if (record.status === 'completed') {
            return { status: record.response_code, body: record.response_body, replayed: true };
        }
        // in_progress (or a failed record a concurrent retry re-claimed first)
        return {
            status: 409,
            body: { error: "A request with this Idempotency-Key is already in progress; retry later" },
            headers: { 'Retry-After': '1' },
        };
    }

    const result = await runSafely(handler, label);

    const { error: finalizeError } = await supabase
        .from('idempotency_keys')
        .update({
            status: isRetryableResult(result) ? 'failed' : 'completed',
            response_code: result.status,
            response_body: result.body,
            updated_at: new Date().toISOString(),
        })
        .eq('id', record.id);

    // The response is still returned; the key stays in_progress until the timeout lets a retry re-run it
    if (finalizeError) console.error(`Error finalizing idempotency key for ${label}:`, finalizeError);

    return result;
};

/**
 * Runs `fn` while holding the per-subscription billing lease, so two billing
 * operations for the same subscription never overlap. Returns a retryable 409
 * without running `fn` when another holder's lease is live. If `fn` returns
 * { holdLock: true } the lease is left to expire on its own instead of being released.
 */
const withBillingLock = async ({ supabase, subscriptionId, ttlSeconds }, fn) => {
    const lockToken = crypto.randomUUID();
    const { data: acquired, error: acquireError } = await supabase.rpc('acquire_billing_lock', {
        p_subscription_id: subscriptionId,
        p_lock_token: lockToken,
        p_ttl_seconds: ttlSeconds,
    });
    if (acquireError) throw acquireError;
    if (!acquired) {
        return {
            status: 409,
            body: { error: "A billing operation for this subscription is already in progress" },
            headers: { 'Retry-After': '5' },
            retryable: true,
        };
    }

    let holdLock = false;
    try {
        const result = await fn();
        holdLock = result?.holdLock === true;
        return result;
    } finally {
        if (!holdLock) {
            const { error: releaseError } = await supabase.rpc('release_billing_lock', {
                p_subscription_id: subscriptionId,
                p_lock_token: lockToken,
            });
            // Not fatal: the lease expires after ttlSeconds
            if (releaseError) console.error("Error releasing billing lock:", releaseError);
        }
    }
};

const sendResult = (res, { status, body, headers, replayed }) => {
    if (headers) res.set(headers);
    if (replayed) res.set('Idempotent-Replayed', 'true');
    return res.status(status).json(body);
};

module.exports = {
    executeIdempotently,
    withBillingLock,
    sendResult,
    hashRequestBody,
    readIdempotencyKey,
};
