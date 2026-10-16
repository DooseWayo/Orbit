import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Keypair, StrKey, Account, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import app from '../index.js';
import { makeApiKey } from './helpers.js';
import { hashRequestBody } from '../idempotency.js';

describe('Idempotency keys and billing locks', () => {
  const validMerchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
  const validPlanId = 'e0b8e99b-5136-4d1d-9351-91a5db4fb056';
  const validSubscriptionId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
  const idempotencyRecordId = '0d6c1f0e-9f2a-4c43-9c1e-5a7b8c9d0e1f';
  const validStellarAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  const planBody = {
    merchant_id: validMerchantId,
    name: 'Pro Plan',
    usdc_amount: 290000000,
    interval_seconds: 2592000,
  };

  let mockSupabase;
  let apiKey;
  let rpcHandlers;

  const claimResult = (claimed, record = {}) => ({
    data: {
      claimed,
      record: { id: idempotencyRecordId, status: 'in_progress', ...record },
    },
    error: null,
  });

  const finalizeCall = () =>
    mockSupabase.update.mock.calls.find(([values]) => 'response_code' in values)?.[0];

  beforeEach(() => {
    rpcHandlers = {
      claim_idempotency_key: () => claimResult(true),
      acquire_billing_lock: () => ({ data: true, error: null }),
      release_billing_lock: () => ({ data: true, error: null }),
    };

    mockSupabase = {
      from: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { id: validPlanId, name: 'Pro Plan', usdc_amount: 290000000 },
        error: null,
      }),
      update: vi.fn().mockReturnThis(),
      rpc: vi.fn(async (fn, args) => rpcHandlers[fn](args)),
    };

    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: validStellarAddress });
    // API key lookup performed by the auth middleware
    mockSupabase.maybeSingle = vi.fn().mockResolvedValue({ data: apiKey.row, error: null });

    app.locals.supabase = mockSupabase;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
  });

  describe('request hashing', () => {
    it('hashes bodies independently of key order', () => {
      expect(hashRequestBody({ a: 1, b: { c: 2, d: 3 } })).toBe(hashRequestBody({ b: { d: 3, c: 2 }, a: 1 }));
    });

    it('produces different hashes for different bodies', () => {
      expect(hashRequestBody({ a: 1 })).not.toBe(hashRequestBody({ a: 2 }));
    });
  });

  describe('POST /plans with Idempotency-Key', () => {
    it('runs the request once and stores the response as completed', async () => {
      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'key-1').send(planBody);

      expect(res.status).toBe(201);
      expect(res.headers['idempotent-replayed']).toBeUndefined();
      expect(mockSupabase.rpc).toHaveBeenCalledWith('claim_idempotency_key', expect.objectContaining({
        p_merchant_id: validMerchantId,
        p_key: 'key-1',
        p_request_path: '/plans',
        p_request_hash: hashRequestBody(planBody),
        p_ttl_seconds: 86400,
      }));
      expect(mockSupabase.insert).toHaveBeenCalledTimes(1);
      expect(finalizeCall()).toMatchObject({ status: 'completed', response_code: 201 });
      expect(mockSupabase.eq).toHaveBeenCalledWith('id', idempotencyRecordId);
    });

    it('replays the stored response on retry without re-executing', async () => {
      rpcHandlers.claim_idempotency_key = () => claimResult(false, {
        status: 'completed',
        request_path: '/plans',
        request_hash: hashRequestBody(planBody),
        response_code: 201,
        response_body: { message: 'Plan created successfully', plan: { id: validPlanId } },
      });

      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'key-1').send(planBody);

      expect(res.status).toBe(201);
      expect(res.body.plan.id).toBe(validPlanId);
      expect(res.headers['idempotent-replayed']).toBe('true');
      expect(mockSupabase.insert).not.toHaveBeenCalled();
      expect(mockSupabase.update).not.toHaveBeenCalled();
    });

    it('returns 409 while the original request is still in progress', async () => {
      rpcHandlers.claim_idempotency_key = () => claimResult(false, {
        status: 'in_progress',
        request_path: '/plans',
        request_hash: hashRequestBody(planBody),
      });

      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'key-1').send(planBody);

      expect(res.status).toBe(409);
      expect(res.headers['retry-after']).toBe('1');
      expect(mockSupabase.insert).not.toHaveBeenCalled();
    });

    it('returns 422 when the key is reused with a different body', async () => {
      rpcHandlers.claim_idempotency_key = () => claimResult(false, {
        status: 'completed',
        request_path: '/plans',
        request_hash: hashRequestBody({ ...planBody, name: 'Other Plan' }),
        response_code: 201,
        response_body: {},
      });

      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'key-1').send(planBody);

      expect(res.status).toBe(422);
      expect(mockSupabase.insert).not.toHaveBeenCalled();
    });

    it('returns 422 when the key is reused on a different endpoint', async () => {
      rpcHandlers.claim_idempotency_key = () => claimResult(false, {
        status: 'completed',
        request_path: '/subscriptions',
        request_hash: hashRequestBody(planBody),
        response_code: 201,
        response_body: {},
      });

      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'key-1').send(planBody);

      expect(res.status).toBe(422);
    });

    it('rejects an over-long key with 400', async () => {
      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'k'.repeat(256)).send(planBody);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Idempotency-Key');
      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });

    it('marks the key failed on a server error so a retry can re-run it', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      });

      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'key-1').send(planBody);

      expect(res.status).toBe(500);
      expect(finalizeCall()).toMatchObject({ status: 'failed', response_code: 500 });
    });

    it('returns 404 when the merchant scoping the key does not exist', async () => {
      rpcHandlers.claim_idempotency_key = () => ({
        data: null,
        error: { code: '23503', message: 'violates foreign key constraint' },
      });

      const res = await request(app).post('/plans').set('Authorization', apiKey.header).set('Idempotency-Key', 'key-1').send(planBody);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Merchant not found');
      expect(mockSupabase.insert).not.toHaveBeenCalled();
    });

    it('does not touch idempotency storage when no key is sent', async () => {
      const res = await request(app).post('/plans').set('Authorization', apiKey.header).send(planBody);

      expect(res.status).toBe(201);
      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });
  });

  describe('POST /subscriptions with Idempotency-Key', () => {
    const subscriptionBody = { plan_id: validPlanId, customer_wallet_address: validStellarAddress };

    it('scopes the key to the merchant that owns the plan', async () => {
      mockSupabase.single
        .mockResolvedValueOnce({ data: { merchant_id: validMerchantId }, error: null })
        .mockResolvedValueOnce({ data: { id: validSubscriptionId }, error: null });

      const res = await request(app).post('/subscriptions').set('Idempotency-Key', 'sub-1').send(subscriptionBody);

      expect(res.status).toBe(201);
      expect(mockSupabase.rpc).toHaveBeenCalledWith('claim_idempotency_key', expect.objectContaining({
        p_merchant_id: validMerchantId,
        p_request_path: '/subscriptions',
      }));
      expect(finalizeCall()).toMatchObject({ status: 'completed', response_code: 201 });
    });

    it('returns 404 without claiming a key when the plan does not exist', async () => {
      mockSupabase.single.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

      const res = await request(app).post('/subscriptions').set('Idempotency-Key', 'sub-1').send(subscriptionBody);

      expect(res.status).toBe(404);
      expect(mockSupabase.rpc).not.toHaveBeenCalled();
    });

    it('returns 409 for a duplicate subscription instead of a 500', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: null,
        error: { code: '23505', message: 'duplicate key value violates unique constraint' },
      });

      const res = await request(app).post('/subscriptions').send(subscriptionBody);

      expect(res.status).toBe(409);
    });
  });

  describe('billing locks on pulls', () => {
    const merchantKeypair = Keypair.random();
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
    let mockServer;

    beforeEach(() => {
      process.env.ORBIT_CONTRACT_ID = contractId;
      app.locals.txPollIntervalMs = 1;
      app.locals.txPollTimeoutMs = 20;

      mockSupabase.single.mockResolvedValue({
        data: {
          id: validSubscriptionId,
          customer_wallet_address: validStellarAddress,
          plans: { merchant_id: validMerchantId, usdc_amount: 290000000, interval_seconds: 2592000 },
        },
        error: null,
      });
      // The merchant wallet comes from the authenticated API key
      apiKey.row.merchants.wallet_address = merchantKeypair.publicKey();

      mockServer = {
        getAccount: vi.fn().mockResolvedValue(new Account(merchantKeypair.publicKey(), '1')),
        prepareTransaction: vi.fn().mockImplementation(async (tx) => tx),
        sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' }),
        getTransaction: vi.fn(),
      };
      app.locals.sorobanServer = mockServer;
    });

    afterEach(() => {
      delete app.locals.sorobanServer;
      delete app.locals.txPollIntervalMs;
      delete app.locals.txPollTimeoutMs;
      delete process.env.ORBIT_CONTRACT_ID;
    });

    const rpcCalls = (fn) => mockSupabase.rpc.mock.calls.filter(([name]) => name === fn);

    const signedPull = async () => {
      const prepared = await request(app).post('/trigger-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId });
      const tx = TransactionBuilder.fromXDR(prepared.body.transaction_xdr, Networks.TESTNET);
      tx.sign(merchantKeypair);
      mockSupabase.rpc.mockClear();
      return tx.toXDR();
    };

    it('acquires and releases the lock around preparing a pull', async () => {
      const res = await request(app).post('/trigger-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId });

      expect(res.status).toBe(200);
      const [[, acquireArgs]] = rpcCalls('acquire_billing_lock');
      expect(acquireArgs).toMatchObject({ p_subscription_id: validSubscriptionId, p_ttl_seconds: 60 });
      const [[, releaseArgs]] = rpcCalls('release_billing_lock');
      expect(releaseArgs.p_lock_token).toBe(acquireArgs.p_lock_token);
    });

    it('returns 409 and skips simulation when another billing operation holds the lock', async () => {
      rpcHandlers.acquire_billing_lock = () => ({ data: false, error: null });

      const res = await request(app).post('/trigger-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId });

      expect(res.status).toBe(409);
      expect(res.headers['retry-after']).toBe('5');
      expect(mockServer.getAccount).not.toHaveBeenCalled();
      expect(mockServer.prepareTransaction).not.toHaveBeenCalled();
      expect(rpcCalls('release_billing_lock')).toHaveLength(0);
    });

    it('marks the idempotency key failed on lock contention so the retry can proceed', async () => {
      rpcHandlers.acquire_billing_lock = () => ({ data: false, error: null });

      const res = await request(app)
        .post('/trigger-pull')
        .set('Authorization', apiKey.header)
        .set('Idempotency-Key', 'pull-1')
        .send({ subscription_id: validSubscriptionId });

      expect(res.status).toBe(409);
      expect(finalizeCall()).toMatchObject({ status: 'failed', response_code: 409 });
    });

    it('does not submit to the network when the submit lock is held', async () => {
      const signed_xdr = await signedPull();
      rpcHandlers.acquire_billing_lock = () => ({ data: false, error: null });

      const res = await request(app).post('/submit-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId, signed_xdr });

      expect(res.status).toBe(409);
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
    });

    it('releases the submit lock after a confirmed pull', async () => {
      mockServer.getTransaction.mockResolvedValue({ status: 'SUCCESS' });
      const signed_xdr = await signedPull();

      const res = await request(app).post('/submit-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId, signed_xdr });

      expect(res.status).toBe(200);
      expect(rpcCalls('acquire_billing_lock')).toHaveLength(1);
      expect(rpcCalls('release_billing_lock')).toHaveLength(1);
    });

    it('releases the submit lock when submission throws', async () => {
      mockServer.sendTransaction.mockResolvedValue({ status: 'ERROR', hash: 'deadbeef' });
      const signed_xdr = await signedPull();

      const res = await request(app).post('/submit-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId, signed_xdr });

      expect(res.status).toBe(500);
      expect(rpcCalls('release_billing_lock')).toHaveLength(1);
    });

    it('keeps the lease while an unconfirmed transaction may still land', async () => {
      mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
      const signed_xdr = await signedPull();

      const res = await request(app).post('/submit-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId, signed_xdr });

      expect(res.status).toBe(202);
      expect(res.body.holdLock).toBeUndefined();
      expect(rpcCalls('acquire_billing_lock')).toHaveLength(1);
      expect(rpcCalls('release_billing_lock')).toHaveLength(0);
    });

    it('replays a completed submit-pull without resubmitting the transaction', async () => {
      const signed_xdr = await signedPull();
      const body = { subscription_id: validSubscriptionId, signed_xdr };
      rpcHandlers.claim_idempotency_key = () => claimResult(false, {
        status: 'completed',
        request_path: '/submit-pull',
        request_hash: hashRequestBody(body),
        response_code: 200,
        response_body: { message: 'Successfully pulled funds on-chain!', txHash: 'deadbeef' },
      });

      const res = await request(app).post('/submit-pull').set('Authorization', apiKey.header).set('Idempotency-Key', 'submit-1').send(body);

      expect(res.status).toBe(200);
      expect(res.body.txHash).toBe('deadbeef');
      expect(res.headers['idempotent-replayed']).toBe('true');
      expect(mockServer.sendTransaction).not.toHaveBeenCalled();
      expect(rpcCalls('acquire_billing_lock')).toHaveLength(0);
    });
  });
});
