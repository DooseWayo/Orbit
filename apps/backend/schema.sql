-- Orbit MVP Database Schema

-- 1. Merchants Table
-- Stores the SaaS founders/businesses using Orbit
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Plans Table
-- Stores the pricing tiers created by the merchant (e.g., "Pro Plan - 29 USDC/month")
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    usdc_amount NUMERIC NOT NULL, -- Storing as numeric to handle large Stellar numbers without precision loss
    interval_seconds BIGINT NOT NULL, -- e.g., 2592000 for 30 days
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Subscriptions Table
-- Stores the customers who have subscribed to a specific plan
CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    customer_wallet_address VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'cancelled', 'past_due'
    next_billing_date TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure a customer can't accidentally subscribe to the exact same plan twice concurrently
    UNIQUE(plan_id, customer_wallet_address)
);

-- 4. Idempotency Keys Table
-- Stores the outcome of mutating requests sent with an Idempotency-Key header so
-- that client retries replay the original response instead of re-executing it.
-- Keys are scoped per merchant and expire after a TTL (24 hours by default).
-- merchant_id is NOT NULL because UNIQUE(merchant_id, key) treats NULLs as
-- distinct, which would silently disable deduplication.
CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(255) NOT NULL,
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    request_path VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL, -- SHA-256 hex of the canonicalized request body
    status VARCHAR(50) NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
    response_code INTEGER,
    response_body JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(), -- last claim/finalize; used to detect abandoned in_progress claims
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    UNIQUE(merchant_id, key)
);

CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- 5. Billing Locks Table
-- Lease-based mutex that serializes billing operations (pull preparation and
-- submission) per subscription. A lease that is never released (e.g. the API
-- process crashed) becomes available again once locked_until passes.
CREATE TABLE billing_locks (
    subscription_id UUID PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
    lock_token UUID NOT NULL,
    locked_until TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Atomically claims an idempotency key. Returns {"claimed": true, "record": ...}
-- when the caller now owns the key and must execute the request, or
-- {"claimed": false, "record": ...} with the existing record otherwise.
-- An existing record is taken over only when it has expired, or when it belongs to
-- the same request (path + body hash) and either failed or was abandoned
-- in_progress for longer than p_in_progress_timeout_seconds.
CREATE OR REPLACE FUNCTION claim_idempotency_key(
    p_merchant_id UUID,
    p_key VARCHAR,
    p_request_path VARCHAR,
    p_request_hash VARCHAR,
    p_ttl_seconds INTEGER,
    p_in_progress_timeout_seconds INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_record idempotency_keys;
BEGIN
    INSERT INTO idempotency_keys (key, merchant_id, request_path, request_hash, status, expires_at)
    VALUES (p_key, p_merchant_id, p_request_path, p_request_hash, 'in_progress', NOW() + make_interval(secs => p_ttl_seconds))
    ON CONFLICT (merchant_id, key) DO UPDATE
        SET request_path = EXCLUDED.request_path,
            request_hash = EXCLUDED.request_hash,
            status = 'in_progress',
            response_code = NULL,
            response_body = NULL,
            created_at = CASE WHEN idempotency_keys.expires_at <= NOW() THEN NOW() ELSE idempotency_keys.created_at END,
            updated_at = NOW(),
            expires_at = EXCLUDED.expires_at
        WHERE idempotency_keys.expires_at <= NOW()
           OR (
                idempotency_keys.request_path = EXCLUDED.request_path
                AND idempotency_keys.request_hash = EXCLUDED.request_hash
                AND (
                    idempotency_keys.status = 'failed'
                    OR (
                        idempotency_keys.status = 'in_progress'
                        AND idempotency_keys.updated_at <= NOW() - make_interval(secs => p_in_progress_timeout_seconds)
                    )
                )
           )
    RETURNING * INTO v_record;

    IF FOUND THEN
        RETURN jsonb_build_object('claimed', true, 'record', to_jsonb(v_record));
    END IF;

    SELECT * INTO v_record
    FROM idempotency_keys
    WHERE merchant_id = p_merchant_id AND key = p_key;

    RETURN jsonb_build_object('claimed', false, 'record', to_jsonb(v_record));
END;
$$;

-- Acquires the billing lease for a subscription. Returns true when acquired,
-- false when another holder's lease is still live.
CREATE OR REPLACE FUNCTION acquire_billing_lock(
    p_subscription_id UUID,
    p_lock_token UUID,
    p_ttl_seconds INTEGER
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO billing_locks (subscription_id, lock_token, locked_until)
    VALUES (p_subscription_id, p_lock_token, NOW() + make_interval(secs => p_ttl_seconds))
    ON CONFLICT (subscription_id) DO UPDATE
        SET lock_token = EXCLUDED.lock_token,
            locked_until = EXCLUDED.locked_until,
            created_at = NOW()
        WHERE billing_locks.locked_until <= NOW();

    RETURN FOUND;
END;
$$;

-- Releases the billing lease, but only if the caller still holds it.
CREATE OR REPLACE FUNCTION release_billing_lock(
    p_subscription_id UUID,
    p_lock_token UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
    DELETE FROM billing_locks
    WHERE subscription_id = p_subscription_id AND lock_token = p_lock_token;

    RETURN FOUND;
END;
$$;

-- Housekeeping: delete expired idempotency keys and stale billing leases.
-- Schedule with pg_cron, e.g. SELECT cron.schedule('purge-idempotency', '0 * * * *', 'SELECT purge_expired_idempotency_keys()');
CREATE OR REPLACE FUNCTION purge_expired_idempotency_keys() RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM idempotency_keys WHERE expires_at <= NOW();
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    DELETE FROM billing_locks WHERE locked_until <= NOW();
    RETURN v_deleted;
END;
$$;

-- These functions are backend-only: Postgres grants EXECUTE to PUBLIC by default
-- and Supabase additionally grants it to anon/authenticated.
REVOKE EXECUTE ON FUNCTION claim_idempotency_key(UUID, VARCHAR, VARCHAR, VARCHAR, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION acquire_billing_lock(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION release_billing_lock(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION purge_expired_idempotency_keys() FROM PUBLIC, anon, authenticated;

-- ==============================================================================
-- Row Level Security (RLS) Configuration
-- ==============================================================================
--
-- Security Model:
-- 1. The backend Express API connects using SUPABASE_SERVICE_ROLE_KEY, which
--    inherently bypasses RLS in PostgreSQL / Supabase.
-- 2. Direct client access using the public anon key is strictly read-only and
--    limited to what the public checkout flow requires (reading plans and
--    associated merchant names and wallet addresses).
-- 3. All table mutations (INSERT, UPDATE, DELETE) across all tables are forbidden
--    to anon/public clients and must be executed through the backend.
-- 4. The subscriptions table has NO public policies defined, enforcing default-deny
--    for the anon key (preventing any direct listing or modification of subscriber data).

ALTER TABLE merchants ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_locks ENABLE ROW LEVEL SECURITY;

-- Public checkout read access for plans and merchant public identifiers
CREATE POLICY "Allow public read access to merchants for checkout"
    ON merchants FOR SELECT
    USING (true);

CREATE POLICY "Allow public read access to plans for checkout"
    ON plans FOR SELECT
    USING (true);

-- No public policies for subscriptions, idempotency_keys or billing_locks:
-- default-deny prevents anon key access.
-- No open INSERT or UPDATE policies: all mutations require backend service role.
