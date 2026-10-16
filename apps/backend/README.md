# Orbit Merchant API

The Orbit Merchant API (`apps/backend/index.js`) is an Express service that manages pricing plans, customer subscriptions, and automated on-chain pull executions on Stellar Soroban. Data is persisted in Supabase using the tables defined in `apps/backend/schema.sql` (`merchants`, `plans`, `subscriptions`).

## Setup and Configuration

### Prerequisites

- Node.js 18+ and npm 9+
- A Supabase project with tables initialized via `apps/backend/schema.sql`
- A deployed Orbit Soroban contract on Stellar Testnet

### Environment Variables

Copy `apps/backend/.env.example` to `apps/backend/.env` and configure:

| Variable | Description | Example |
|---|---|---|
| `PORT` | Local port for Express server (defaults to 3001) | `3001` |
| `SUPABASE_URL` | Supabase project URL | `https://xyzcompany.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role secret key | `eyJhbGciOi...` |
| `ORBIT_CONTRACT_ID` | Deployed Orbit Soroban smart contract ID | `CAZBZBUWBSQYK2RZ6WHMXVDLIQHSU5WD7ANZYL6HLNSCRUOTNYCDYQNG` |
| `IDEMPOTENCY_KEY_TTL_SECONDS` | How long an `Idempotency-Key` replays its stored response (defaults to 24h) | `86400` |
| `IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS` | After this long an unfinished claim is treated as abandoned and may be retried (defaults to 300) | `300` |
| `PREPARE_LOCK_TTL_SECONDS` | Billing lease held while `/trigger-pull` simulates a pull (defaults to 60) | `60` |

### Running the API

```bash
cd apps/backend
npm install
node index.js
```

The service runs at `http://localhost:3001`.

---

## API Routes Overview

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/plans` | Create a new recurring pricing plan |
| `GET` | `/plans/:id` | Fetch plan and merchant details |
| `GET` | `/subscribers` | List active subscribers for a merchant |
| `POST` | `/trigger-pull` | Prepare an unsigned merchant pull transaction |
| `POST` | `/submit-pull` | Verify and submit a wallet-signed pull transaction |
| `POST` | `/subscriptions` | Record a customer subscription after handshake |

---

## Route Reference

### 1. POST /plans

#### Purpose
Creates a new recurring subscription plan for a merchant.

#### Request Body
Content-Type: `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `merchant_id` | `string` (UUID) | Yes | Unique ID of the merchant creating the plan (must exist in `merchants` table). |
| `name` | `string` | Yes | Name of the subscription plan (e.g., `"Pro Plan - 29 USDC/month"`). |
| `usdc_amount` | `integer` | Yes | Billing amount per interval in raw token units. USDC has 7 decimals, so `290000000` is 29 USDC. This is the same unit as the contract's `amount_per_interval`. |
| `interval_seconds` | `number` | Yes | Cadence between billing pulls in seconds (e.g., `2592000` for 30 days). |

#### Example Request

```bash
curl -X POST http://localhost:3001/plans \
  -H "Content-Type: application/json" \
  -d '{
    "merchant_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "name": "Pro Plan - 29 USDC/month",
    "usdc_amount": 290000000,
    "interval_seconds": 2592000
  }'
```

#### Example Success Response
Status: `201 Created`

```json
{
  "message": "Plan created successfully",
  "plan": {
    "id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "merchant_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "name": "Pro Plan - 29 USDC/month",
    "usdc_amount": 290000000,
    "interval_seconds": 2592000,
    "created_at": "2026-09-30T00:00:00.000Z"
  }
}
```

#### Error Responses

- `400 Bad Request`
  Returned when any required field (`merchant_id`, `name`, `usdc_amount`, `interval_seconds`) is missing.
  ```json
  {
    "error": "Missing required fields"
  }
  ```

- `500 Internal Server Error`
  Returned if the database query fails or a foreign key constraint is violated.
  ```json
  {
    "error": "insert or update on table \"plans\" violates foreign key constraint \"plans_merchant_id_fkey\""
  }
  ```

---

### 2. GET /plans/:id

#### Purpose
Fetches details of a specific plan along with the associated merchant's name and Stellar wallet address. Used by checkout widgets and payment pages.

#### URL Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (UUID) | Yes | Unique ID of the plan to fetch. |

#### Example Request

```bash
curl http://localhost:3001/plans/e2a0b3df-2015-4672-9721-a1e94c1408d7
```

#### Example Success Response
Status: `200 OK`

```json
{
  "plan": {
    "id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "merchant_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
    "name": "Pro Plan - 29 USDC/month",
    "usdc_amount": 290000000,
    "interval_seconds": 2592000,
    "created_at": "2026-09-30T00:00:00.000Z",
    "merchants": {
      "name": "Acme SaaS",
      "wallet_address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    }
  }
}
```

#### Error Responses

- `404 Not Found`
  Returned if no plan exists with the given ID.
  ```json
  {
    "error": "Plan not found"
  }
  ```

- `500 Internal Server Error`
  Returned if the database query fails or the ID syntax is invalid.
  ```json
  {
    "error": "invalid input syntax for type uuid: \"invalid-id\""
  }
  ```

---

### 3. GET /subscribers

#### Purpose
Fetches all active subscriptions across plans owned by a specific merchant, used by the merchant dashboard.

#### Query Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `merchant_id` | `string` (UUID) | Yes | Unique ID of the merchant whose subscribers are queried. |

#### Example Request

```bash
curl "http://localhost:3001/subscribers?merchant_id=9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
```

#### Example Success Response
Status: `200 OK`

```json
{
  "subscribers": [
    {
      "id": "c1f7b9e0-1234-5678-9abc-def012345678",
      "plan_id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
      "customer_wallet_address": "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
      "status": "active",
      "next_billing_date": "2026-10-30T00:00:00.000Z",
      "created_at": "2026-09-30T00:00:00.000Z",
      "plans": {
        "merchant_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
        "name": "Pro Plan - 29 USDC/month",
        "usdc_amount": 290000000
      }
    }
  ]
}
```

#### Error Responses

- `400 Bad Request`
  Returned when the `merchant_id` query parameter is missing.
  ```json
  {
    "error": "Missing merchant_id query parameter"
  }
  ```

- `500 Internal Server Error`
  Returned if the database query fails.
  ```json
  {
    "error": "invalid input syntax for type uuid: \"invalid-merchant-id\""
  }
  ```

---

### 4. POST /trigger-pull

#### Purpose
Prepares an unsigned on-chain pull payment for the merchant's registered public address. Orbit never receives a merchant secret key.

The flow:
1. Loads subscription, plan terms, and merchant wallet address from Supabase.
2. Builds and simulates `pull_funds(user, merchant)`.
3. Returns the transaction XDR and network passphrase for signing in the merchant wallet.
4. The client sends the signed envelope to `POST /submit-pull`.
5. The API verifies the merchant signature, submits it, and updates billing state after confirmation.

#### Request Body
Content-Type: `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `subscription_id` | `string` (UUID) | Yes | Unique ID of the subscription to pull funds for. |

#### Example Request

```bash
curl -X POST http://localhost:3001/trigger-pull \
  -H "Content-Type: application/json" \
  -d '{
    "subscription_id": "c1f7b9e0-1234-5678-9abc-def012345678"
  }'
```

#### Example Success Response
Status: `200 OK`

```json
{
  "transaction_xdr": "AAAAAg...",
  "network_passphrase": "Test SDF Network ; September 2015",
  "merchant_address": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "subscription_id": "c1f7b9e0-1234-5678-9abc-def012345678"
}
```

#### Error Responses

- `400 Bad Request`
  Returned when `subscription_id` is missing, malformed, or an unexpected secret field is supplied.
  ```json
  {
    "error": "Invalid input on subscription_id: subscription_id must be a valid UUID"
  }
  ```

- `POST /submit-pull` accepts `{ "subscription_id": "...", "signed_xdr": "..." }`. It returns `401` unless the envelope source and a valid signature match the merchant wallet registered for the plan.
  ```json
  {
    "error": "A valid merchant wallet signature is required"
  }
  ```

- `404 Not Found`
  Returned when the subscription record does not exist.
  ```json
  {
    "error": "Subscription not found"
  }
  ```

- `500 Internal Server Error`
  Returned when `ORBIT_CONTRACT_ID` is not set in `.env`, or the Soroban transaction build, simulation, or submission fails (e.g., interval not elapsed, insufficient allowance).
  ```json
  {
    "error": "ORBIT_CONTRACT_ID not set in .env"
  }
  ```
  ```json
  {
    "error": "Transaction failed: {\"status\":\"FAILED\"}"
  }
  ```

---

### 5. POST /subscriptions

#### Purpose
Records a customer subscription after the customer has executed the on-chain allowance approval and vault creation handshake with the Orbit contract.

Sets `next_billing_date` to the current timestamp (`new Date().toISOString()`), enabling the initial pull immediately.

#### Request Body
Content-Type: `application/json`

| Field | Type | Required | Description |
|---|---|---|---|
| `plan_id` | `string` (UUID) | Yes | Unique ID of the plan being subscribed to. |
| `customer_wallet_address` | `string` | Yes | Stellar public key (`G...`) of the subscriber. |

#### Example Request

```bash
curl -X POST http://localhost:3001/subscriptions \
  -H "Content-Type: application/json" \
  -d '{
    "plan_id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "customer_wallet_address": "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG"
  }'
```

#### Example Success Response
Status: `201 Created`

```json
{
  "message": "Subscription created",
  "subscription": {
    "id": "c1f7b9e0-1234-5678-9abc-def012345678",
    "plan_id": "e2a0b3df-2015-4672-9721-a1e94c1408d7",
    "customer_wallet_address": "GD3AGJRMLRKRTQKBVMLT6AW34IZZ3IEALRHTY247BBNISVS452SMQDPG",
    "status": "active",
    "next_billing_date": "2026-09-30T00:00:00.000Z",
    "created_at": "2026-09-30T00:00:00.000Z"
  }
}
```

#### Error Responses

- `400 Bad Request`
  Returned when `plan_id` or `customer_wallet_address` is missing.
  ```json
  {
    "error": "Missing required fields"
  }
  ```

- `409 Conflict`
  Returned if the customer is already subscribed to the plan (unique constraint on `(plan_id, customer_wallet_address)`).
  ```json
  {
    "error": "This wallet is already subscribed to this plan"
  }
  ```

- `500 Internal Server Error`
  Returned if the database query fails.

---

## Idempotency and Concurrency

### Idempotency-Key header

`POST /plans`, `POST /subscriptions`, `POST /trigger-pull` and `POST /submit-pull` accept an optional `Idempotency-Key` header (1–255 characters, e.g. a UUID v4), following the same conventions as Stripe. Send a fresh key per logical operation and reuse it verbatim when retrying after a timeout or network error.

Keys are scoped to the merchant that owns the resource (the `merchant_id` of the plan, or of the subscription's plan) and are stored in the `idempotency_keys` table for 24 hours.

| Situation | Response |
|---|---|
| First request with a key | Executed normally; the response is stored |
| Retry after it completed | The stored status code and body are replayed with header `Idempotent-Replayed: true`; nothing is re-executed |
| Retry while the first request is still running | `409 Conflict` with `Retry-After` |
| Same key, different endpoint or request body | `422 Unprocessable Entity` |
| First attempt ended in a `5xx` or a transient `409` (billing lock busy) | The key is marked `failed` and the next retry with the same body executes again |
| Header empty or longer than 255 characters | `400 Bad Request` |

The request body is hashed with SHA-256 after sorting object keys, so key order does not matter. Claiming a key is a single atomic statement (`claim_idempotency_key`), so concurrent duplicates cannot both execute. An attempt whose process died mid-request is recoverable after `IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS`.

### Per-subscription billing lock

Independently of idempotency keys, `/trigger-pull` and `/submit-pull` take a lease on the subscription in the `billing_locks` table (`acquire_billing_lock` / `release_billing_lock`). A second billing operation on the same subscription while the lease is held gets `409 Conflict` with `Retry-After` and never reaches Soroban simulation or submission. Leases expire automatically (60s for preparation, the confirmation poll timeout plus 60s for submission), so a crashed process cannot block billing permanently. When `/submit-pull` returns `202` (transaction submitted but unconfirmed), the lease is deliberately kept until it expires so no second pull can race the one still in flight.

### Housekeeping

`purge_expired_idempotency_keys()` deletes expired keys and stale leases. Schedule it with `pg_cron`, for example:

```sql
SELECT cron.schedule('purge-idempotency', '0 * * * *', 'SELECT purge_expired_idempotency_keys()');
```

---

## Database Schema Reference

The API queries the tables defined in `apps/backend/schema.sql`:

- `merchants`: `id` (UUID PK), `wallet_address` (VARCHAR UNIQUE), `name` (VARCHAR), `created_at` (TIMESTAMP).
- `plans`: `id` (UUID PK), `merchant_id` (UUID FK -> `merchants.id`), `name` (VARCHAR), `usdc_amount` (NUMERIC), `interval_seconds` (BIGINT), `created_at` (TIMESTAMP).
- `subscriptions`: `id` (UUID PK), `plan_id` (UUID FK -> `plans.id`), `customer_wallet_address` (VARCHAR), `status` (VARCHAR DEFAULT 'active'), `next_billing_date` (TIMESTAMP), `created_at` (TIMESTAMP).
- `idempotency_keys`: `id` (UUID PK), `key` (VARCHAR), `merchant_id` (UUID FK -> `merchants.id`, cascade), `request_path` (VARCHAR), `request_hash` (VARCHAR(64)), `status` (`in_progress` / `completed` / `failed`), `response_code` (INTEGER), `response_body` (JSONB), `created_at`, `updated_at`, `expires_at` (TIMESTAMP). Unique on `(merchant_id, key)`.
- `billing_locks`: `subscription_id` (UUID PK, FK -> `subscriptions.id`), `lock_token` (UUID), `locked_until` (TIMESTAMP), `created_at` (TIMESTAMP).

Existing databases can apply the new section of `schema.sql` (tables 4 and 5, their functions, `REVOKE`s and RLS statements) as a migration.

### Row Level Security (RLS) Policy Model

Row Level Security is enabled on all tables in `schema.sql` with a locked-down principle of least privilege:

1. **Backend Service Role**: The backend Express API connects with `SUPABASE_SERVICE_ROLE_KEY`. The Postgres service role possesses the `BYPASSRLS` privilege, granting the backend full authority to execute queries, create plans, record subscriptions, and advance billing schedules.
2. **Public Anon Access (Checkout Flow)**: Direct access via the public Supabase anon key is restricted to `SELECT` on `plans` and `merchants`. This allows unauthenticated checkout widgets and client browsers to inspect plan details and the merchant's recipient address.
3. **No Public Mutations**: Open `INSERT` and `UPDATE` policies have been removed from all tables. Clients cannot directly inject plans, alter subscriptions, or create unauthorized merchant accounts with the anon key.
4. **Subscription Confidentiality**: The `subscriptions`, `idempotency_keys` and `billing_locks` tables have **no** policies granted to public/anon roles. Postgres default-deny prevents unauthenticated or client-side anon requests from querying subscriber lists or viewing competitor customer accounts.

---

## Response and Error Conventions

- All JSON responses return UTF-8 encoded text.
- Successful mutations return `201 Created` with a `message` and entity payload (`plan`, `subscription`).
- Successful queries return `200 OK` with an entity or collection payload (`plan`, `subscribers`).
- Errors return an appropriate HTTP status code (`400`, `401`, `404`, `409`, `422`, `500`) with a JSON payload of shape:
  ```json
  {
    "error": "Error description message"
  }
  ```
