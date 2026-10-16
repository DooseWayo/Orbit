const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { z } = require('zod');
const { StrKey, Keypair, rpc, Networks, TransactionBuilder, Contract, Address } = require('@stellar/stellar-sdk');
const { executeIdempotently, withBillingLock, sendResult } = require('./idempotency');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Using service role for backend logic
let defaultSupabase = null;
if (supabaseUrl && supabaseKey) {
    defaultSupabase = createClient(supabaseUrl, supabaseKey);
}

const getSupabase = () => app.locals.supabase || defaultSupabase;

// Allows tests to inject a mock Soroban RPC server instead of hitting testnet
const getSorobanServer = (rpcUrl) => app.locals.sorobanServer || new rpc.Server(rpcUrl);

// How long to keep polling getTransaction() for a submitted hash before giving up
const TX_POLL_TIMEOUT_MS = Number(process.env.TX_POLL_TIMEOUT_MS) || 30000;
const TX_POLL_INTERVAL_MS = Number(process.env.TX_POLL_INTERVAL_MS) || 1000;

// Billing lease for preparing a pull (simulation only)
const PREPARE_LOCK_TTL_SECONDS = Number(process.env.PREPARE_LOCK_TTL_SECONDS) || 60;
// Billing lease for submitting a pull must outlive confirmation polling
const submitLockTtlSeconds = (pollTimeoutMs) => Math.ceil(pollTimeoutMs / 1000) + 60;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls getTransaction(hash) until it settles to SUCCESS/FAILED, or returns NOT_FOUND on timeout
const waitForTransaction = async (server, hash, { timeoutMs = TX_POLL_TIMEOUT_MS, intervalMs = TX_POLL_INTERVAL_MS } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let lastResponse = await server.getTransaction(hash);

    while (lastResponse.status === "NOT_FOUND" && Date.now() < deadline) {
        await sleep(intervalMs);
        lastResponse = await server.getTransaction(hash);
    }

    return lastResponse;
};

// ==========================================
// VALIDATION SCHEMAS
// ==========================================

const stellarAddressSchema = z.string().refine(
    (val) => StrKey.isValidEd25519PublicKey(val),
    { message: "must be a valid Stellar Ed25519 public address" }
);

const createPlanSchema = z.object({
    merchant_id: z.string().uuid("merchant_id must be a valid UUID"),
    name: z.string().trim().min(1, "name cannot be empty"),
    // Raw token units (USDC has 7 decimals, so 290000000 = 29 USDC), same as the contract's amount_per_interval
    usdc_amount: z.coerce.number()
        .int("usdc_amount must be an integer in raw token units")
        .positive("usdc_amount must be greater than 0"),
    interval_seconds: z.coerce.number().int().positive("interval_seconds must be a positive integer"),
});

const getPlanParamsSchema = z.object({
    id: z.string().uuid("id parameter must be a valid UUID"),
});

const getSubscribersQuerySchema = z.object({
    merchant_id: z.string().uuid("merchant_id must be a valid UUID"),
});

const createSubscriptionSchema = z.object({
    plan_id: z.string().uuid("plan_id must be a valid UUID"),
    customer_wallet_address: stellarAddressSchema,
});

const triggerPullSchema = z.object({
    subscription_id: z.string().uuid("subscription_id must be a valid UUID"),
}).strict();

const submitPullSchema = z.object({
    subscription_id: z.string().uuid("subscription_id must be a valid UUID"),
    signed_xdr: z.string().min(1, "signed_xdr is required"),
}).strict();

// PostgREST reports a .single() lookup that matched no rows as an error, not as empty data
const isNoRowsError = (error) => error?.code === 'PGRST116';

// Postgres foreign key violation, e.g. inserting a subscription for a plan that does not exist
const isForeignKeyError = (error) => error?.code === '23503';

// Postgres unique violation, e.g. the same wallet subscribing to the same plan twice
const isUniqueViolation = (error) => error?.code === '23505';

const formatZodError = (err) => {
    const issue = err.issues[0];
    const field = issue.path.join('.') || 'input';
    return `Invalid input on ${field}: ${issue.message}`;
};

// ==========================================
// ROUTE 1: POST /plans (Create a new pricing plan)
// ==========================================
app.post('/plans', async (req, res) => {
    const parseResult = createPlanSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }

    const { merchant_id, name, usdc_amount, interval_seconds } = parseResult.data;
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });

    const result = await executeIdempotently({
        supabase,
        req,
        label: "creating plan",
        resolveMerchant: () => ({ merchantId: merchant_id }),
    }, async () => {
        const { data, error } = await supabase
            .from('plans')
            .insert([{ merchant_id, name, usdc_amount, interval_seconds }])
            .select()
            .single();

        if (isForeignKeyError(error)) return { status: 404, body: { error: "Merchant not found" } };
        if (error) throw error;

        return { status: 201, body: { message: "Plan created successfully", plan: data } };
    });
    sendResult(res, result);
});

// ==========================================
// ROUTE 2: GET /plans/:id (Fetch plan details for Checkout Widget)
// ==========================================
app.get('/plans/:id', async (req, res) => {
    const parseResult = getPlanParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }

    try {
        const { id } = parseResult.data;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });

        const { data, error } = await supabase
            .from('plans')
            .select('*, merchants(name, wallet_address)') // Also fetch the merchant's details
            .eq('id', id)
            .single();

        if (isNoRowsError(error)) return res.status(404).json({ error: "Plan not found" });
        if (error) throw error;
        if (!data) return res.status(404).json({ error: "Plan not found" });

        res.status(200).json({ plan: data });
    } catch (err) {
        console.error("Error fetching plan:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROUTE 3: GET /subscribers (Fetch active subscribers for dashboard)
// ==========================================
app.get('/subscribers', async (req, res) => {
    const parseResult = getSubscribersQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }

    try {
        const { merchant_id } = parseResult.data;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });

        // Find all subscriptions tied to plans owned by this merchant
        const { data, error } = await supabase
            .from('subscriptions')
            .select(`
                *,
                plans!inner(merchant_id, name, usdc_amount)
            `)
            .eq('plans.merchant_id', merchant_id);

        if (error) throw error;

        res.status(200).json({ subscribers: data });
    } catch (err) {
        console.error("Error fetching subscribers:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROUTE 4: POST /trigger-pull (The Blockchain Bridge)
// ==========================================
const loadPullContext = async (supabase, subscriptionId) => {
    const { data: sub, error: subError } = await supabase
        .from('subscriptions')
        .select(`
            *,
            plans ( merchant_id, usdc_amount, interval_seconds )
        `)
        .eq('id', subscriptionId)
        .single();

    if (isNoRowsError(subError) || !sub) return { status: 404, error: "Subscription not found" };
    if (subError) throw subError;

    const { data: merchant, error: merchantError } = await supabase
        .from('merchants')
        .select('wallet_address')
        .eq('id', sub.plans.merchant_id)
        .single();

    if (isNoRowsError(merchantError) || !merchant) return { status: 404, error: "Merchant not found" };
    if (merchantError) throw merchantError;
    return { sub, merchant };
};

app.post('/trigger-pull', async (req, res) => {
    const parseResult = triggerPullSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }

    try {
        const { subscription_id } = parseResult.data;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });

        const context = await loadPullContext(supabase, subscription_id);
        if (context.error) return res.status(context.status).json({ error: context.error });
        const { sub, merchant } = context;

        const result = await executeIdempotently({
            supabase,
            req,
            label: "preparing pull",
            resolveMerchant: () => ({ merchantId: sub.plans.merchant_id }),
        }, () => withBillingLock({
            supabase,
            subscriptionId: subscription_id,
            ttlSeconds: PREPARE_LOCK_TTL_SECONDS,
        }, async () => {
            const ORBIT_CONTRACT_ID = process.env.ORBIT_CONTRACT_ID;
            if (!ORBIT_CONTRACT_ID) {
                return { status: 500, body: { error: "ORBIT_CONTRACT_ID not set in .env" } };
            }

            const rpcUrl = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
            const server = getSorobanServer(rpcUrl);
            const contract = new Contract(ORBIT_CONTRACT_ID);

            // 3. Build the Soroban Transaction
            const account = await server.getAccount(merchant.wallet_address);

            const tx = new TransactionBuilder(account, {
                fee: "1000000",
                networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET
            })
            .addOperation(contract.call("pull_funds",
                Address.fromString(sub.customer_wallet_address).toScVal(),
                Address.fromString(merchant.wallet_address).toScVal()
            ))
            .setTimeout(30)
            .build();

            // Simulate and return an unsigned envelope. The merchant signs it in their wallet.
            const preparedTx = await server.prepareTransaction(tx);
            return {
                status: 200,
                body: {
                    transaction_xdr: preparedTx.toXDR(),
                    network_passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET,
                    merchant_address: merchant.wallet_address,
                    subscription_id,
                },
            };
        }));
        sendResult(res, result);
    } catch (err) {
        console.error("Error preparing pull:", err);
        res.status(500).json({ error: err.message });
    }
});

// Accept only a wallet-signed envelope, verify the merchant signature, then submit it.
app.post('/submit-pull', async (req, res) => {
    const parseResult = submitPullSchema.safeParse(req.body);
    if (!parseResult.success) return res.status(400).json({ error: formatZodError(parseResult.error) });

    try {
        const { subscription_id, signed_xdr } = parseResult.data;
        const supabase = getSupabase();
        if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });
        const context = await loadPullContext(supabase, subscription_id);
        if (context.error) return res.status(context.status).json({ error: context.error });
        const { sub, merchant } = context;

        const pollTimeoutMs = app.locals.txPollTimeoutMs ?? TX_POLL_TIMEOUT_MS;

        const result = await executeIdempotently({
            supabase,
            req,
            label: "submitting pull",
            resolveMerchant: () => ({ merchantId: sub.plans.merchant_id }),
        }, async () => {
            const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
            let signedTx;
            try {
                signedTx = TransactionBuilder.fromXDR(signed_xdr, networkPassphrase);
            } catch {
                return { status: 400, body: { error: "signed_xdr is not a valid Stellar transaction envelope" } };
            }
            if (signedTx.source !== merchant.wallet_address) {
                return { status: 401, body: { error: "Transaction source does not match the plan owner's address" } };
            }
            const invocation = signedTx.operations.length === 1 && signedTx.operations[0].type === 'invokeHostFunction'
                ? signedTx.operations[0].func?.invokeContract
                : null;
            const isExpectedPull = invocation
                && invocation.functionName.toString() === 'pull_funds'
                && StrKey.encodeContract(invocation.contractAddress.contractId.value) === process.env.ORBIT_CONTRACT_ID
                && invocation.args.length === 2
                && Address.fromScVal(invocation.args[0]).toString() === sub.customer_wallet_address
                && Address.fromScVal(invocation.args[1]).toString() === merchant.wallet_address;
            if (!isExpectedPull) {
                return { status: 400, body: { error: "Signed transaction does not match this subscription's pull" } };
            }
            const merchantKey = Keypair.fromPublicKey(merchant.wallet_address);
            const hasMerchantSignature = signedTx.signatures.some(({ signature }) =>
                merchantKey.verify(signedTx.hash(), signature.value)
            );
            if (!hasMerchantSignature) {
                return { status: 401, body: { error: "A valid merchant wallet signature is required" } };
            }

            // Only one submission per subscription may be in flight at a time
            return withBillingLock({
                supabase,
                subscriptionId: subscription_id,
                ttlSeconds: submitLockTtlSeconds(pollTimeoutMs),
            }, async () => {
                const server = getSorobanServer(process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org');
                const submitResponse = await server.sendTransaction(signedTx);

                if (submitResponse.status !== "PENDING" && submitResponse.status !== "SUCCESS") {
                    throw new Error(`Transaction submission failed: ${JSON.stringify(submitResponse)}`);
                }

                const txHash = submitResponse.hash;

                // 5. Confirm the transaction actually landed before touching billing state
                const confirmation = await waitForTransaction(server, txHash, {
                    timeoutMs: pollTimeoutMs,
                    intervalMs: app.locals.txPollIntervalMs ?? TX_POLL_INTERVAL_MS,
                });

                if (confirmation.status === "SUCCESS") {
                    const pullTime = new Date();
                    const nextBilling = new Date(pullTime.getTime() + Number(sub.plans.interval_seconds) * 1000);

                    await supabase
                        .from('subscriptions')
                        .update({ next_billing_date: nextBilling.toISOString() })
                        .eq('id', subscription_id);

                    return {
                        status: 200,
                        body: { message: "Successfully pulled funds on-chain!", txHash },
                    };
                }

                if (confirmation.status === "FAILED") {
                    await supabase
                        .from('subscriptions')
                        .update({ status: 'past_due' })
                        .eq('id', subscription_id);

                    return {
                        status: 502,
                        body: { error: "Transaction failed on-chain", txHash },
                    };
                }

                // Still NOT_FOUND after the timeout: outcome unknown, let the caller poll later.
                // Keep the lease until it expires so no second pull races the one still in flight.
                return {
                    status: 202,
                    body: { message: "Transaction submitted but not yet confirmed; check back later", txHash },
                    holdLock: true,
                };
            });
        });
        sendResult(res, result);
    } catch (err) {
        console.error("Error submitting pull:", err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ROUTE 5: POST /subscriptions (Create Subscription after Handshake)
// ==========================================
app.post('/subscriptions', async (req, res) => {
    const parseResult = createSubscriptionSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({ error: formatZodError(parseResult.error) });
    }

    const { plan_id, customer_wallet_address } = parseResult.data;
    const supabase = getSupabase();
    if (!supabase) return res.status(500).json({ error: "Supabase client not initialized" });

    const result = await executeIdempotently({
        supabase,
        req,
        label: "creating subscription",
        // Idempotency keys are scoped to the merchant that owns the plan
        resolveMerchant: async () => {
            const { data: plan, error } = await supabase
                .from('plans')
                .select('merchant_id')
                .eq('id', plan_id)
                .single();
            if (isNoRowsError(error) || !plan) return { status: 404, body: { error: "Plan not found" } };
            if (error) throw error;
            return { merchantId: plan.merchant_id };
        },
    }, async () => {
        const nextBillingDate = new Date().toISOString();

        const { data, error } = await supabase
            .from('subscriptions')
            .insert([{ plan_id, customer_wallet_address, next_billing_date: nextBillingDate }])
            .select()
            .single();

        if (isForeignKeyError(error)) return { status: 404, body: { error: "Plan not found" } };
        if (isUniqueViolation(error)) {
            return { status: 409, body: { error: "This wallet is already subscribed to this plan" } };
        }
        if (error) throw error;

        return { status: 201, body: { message: "Subscription created", subscription: data } };
    });
    sendResult(res, result);
});

const PORT = process.env.PORT || 3001;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Orbit Merchant API running on http://localhost:${PORT}`);
    });
}

module.exports = app;
