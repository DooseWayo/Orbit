import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { Keypair, StrKey, Account, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import app from '../index.js';
import { makeApiKey } from './helpers.js';

describe('Merchant API Route Validation & Responses', () => {
  const validMerchantId = '7f8b9a10-b2c3-4d5e-a6f7-112233445566';
  const validPlanId = 'e0b8e99b-5136-4d1d-9351-91a5db4fb056';
  const validSubscriptionId = '4a7f2e18-6c51-41b9-9cf3-90d1bf379b32';
  // Standard valid Stellar Ed25519 public address (G...)
  const validStellarAddress = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  let mockSupabase;
  let apiKey;

  beforeEach(() => {
    // Create chainable mock Supabase client
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
      // Billing lock RPCs: acquire/release always succeed unless a test overrides them
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };

    apiKey = makeApiKey({ merchantId: validMerchantId, walletAddress: validStellarAddress });
    // API key lookup performed by the auth middleware
    mockSupabase.maybeSingle = vi.fn().mockResolvedValue({ data: apiKey.row, error: null });

    app.locals.supabase = mockSupabase;
    app.locals.rateLimiters.ip.reset();
    app.locals.rateLimiters.apiKey.reset();
  });

  // ==========================================
  // POST /plans
  // ==========================================
  describe('POST /plans', () => {
    it('creates a plan successfully with valid data', async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({
          merchant_id: validMerchantId,
          name: 'Pro Plan',
          usdc_amount: 290000000,
          interval_seconds: 2592000,
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe('Plan created successfully');
      expect(mockSupabase.from).toHaveBeenCalledWith('plans');
    });

    it('rejects missing fields with 400 and explicit field name', async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({
          name: 'Pro Plan',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('usdc_amount');
    });

    it('scopes the plan to the authenticated merchant when merchant_id is omitted', async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({ name: 'Pro Plan', usdc_amount: 290000000, interval_seconds: 2592000 });

      expect(res.status).toBe(201);
      expect(mockSupabase.insert).toHaveBeenCalledWith([
        expect.objectContaining({ merchant_id: validMerchantId }),
      ]);
    });

    it("rejects a merchant_id belonging to another merchant with 403", async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({
          merchant_id: '00000000-0000-4000-8000-000000000000',
          name: 'Pro Plan',
          usdc_amount: 290000000,
          interval_seconds: 2592000,
        });

      expect(res.status).toBe(403);
      expect(mockSupabase.insert).not.toHaveBeenCalled();
    });

    it('rejects invalid merchant_id UUID with 400', async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({
          merchant_id: 'not-a-valid-uuid',
          name: 'Pro Plan',
          usdc_amount: 290000000,
          interval_seconds: 2592000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('merchant_id');
    });

    it('rejects negative or zero usdc_amount with 400', async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({
          merchant_id: validMerchantId,
          name: 'Pro Plan',
          usdc_amount: -5,
          interval_seconds: 2592000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('usdc_amount');
    });

    it('rejects a non-integer usdc_amount with 400', async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({
          merchant_id: validMerchantId,
          name: 'Pro Plan',
          usdc_amount: 29.5,
          interval_seconds: 2592000,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('usdc_amount');
    });

    it('rejects non-positive interval_seconds with 400', async () => {
      const res = await request(app)
        .post('/plans')
        .set('Authorization', apiKey.header)
        .send({
          merchant_id: validMerchantId,
          name: 'Pro Plan',
          usdc_amount: 290000000,
          interval_seconds: 0,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('interval_seconds');
    });
  });

  // ==========================================
  // GET /plans/:id
  // ==========================================
  describe('GET /plans/:id', () => {
    it('returns plan details for a valid UUID', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: { id: validPlanId, name: 'Pro Plan', merchants: { name: 'Acme', wallet_address: validStellarAddress } },
        error: null,
      });

      const res = await request(app).get(`/plans/${validPlanId}`);

      expect(res.status).toBe(200);
      expect(res.body.plan.id).toBe(validPlanId);
      expect(mockSupabase.from).toHaveBeenCalledWith('plans');
    });

    it('returns 400 when plan id is not a valid UUID', async () => {
      const res = await request(app).get('/plans/invalid-id-123');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('id');
    });

    it('returns 404 when plan is not found in database', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: null,
        error: null,
      });

      const res = await request(app).get(`/plans/${validPlanId}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Plan not found');
    });

    it('returns 404 when Supabase reports no matching row', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      });

      const res = await request(app).get(`/plans/${validPlanId}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Plan not found');
    });

    it('returns 500 for other database errors', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      });

      const res = await request(app).get(`/plans/${validPlanId}`);

      expect(res.status).toBe(500);
    });
  });

  // ==========================================
  // GET /subscribers
  // ==========================================
  describe('GET /subscribers', () => {
    it('returns subscribers list for valid merchant_id query param', async () => {
      mockSupabase.eq.mockReturnValueOnce(mockSupabase).mockResolvedValueOnce({
        data: [{ id: 'sub-1', customer_wallet_address: validStellarAddress }],
        error: null,
      });

      const res = await request(app).get(`/subscribers?merchant_id=${validMerchantId}`).set('Authorization', apiKey.header);

      expect(res.status).toBe(200);
      expect(res.body.subscribers).toHaveLength(1);
    });

    it('scopes the query to the authenticated merchant when merchant_id is omitted', async () => {
      // First eq() is the API key lookup, second is the subscribers query
      mockSupabase.eq.mockReturnValueOnce(mockSupabase).mockResolvedValueOnce({ data: [], error: null });

      const res = await request(app).get('/subscribers').set('Authorization', apiKey.header);

      expect(res.status).toBe(200);
      expect(mockSupabase.eq).toHaveBeenCalledWith('plans.merchant_id', validMerchantId);
    });

    it("returns 403 when merchant_id names another merchant", async () => {
      const res = await request(app)
        .get('/subscribers?merchant_id=00000000-0000-4000-8000-000000000000')
        .set('Authorization', apiKey.header);

      expect(res.status).toBe(403);
      expect(mockSupabase.eq).not.toHaveBeenCalledWith('plans.merchant_id', expect.anything());
    });

    it('returns 400 when merchant_id is an invalid UUID', async () => {
      const res = await request(app).get('/subscribers?merchant_id=abc').set('Authorization', apiKey.header);

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('merchant_id');
    });
  });

  // ==========================================
  // POST /subscriptions
  // ==========================================
  describe('POST /subscriptions', () => {
    it('creates a subscription with valid plan_id and Stellar address', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: { id: validSubscriptionId, plan_id: validPlanId, customer_wallet_address: validStellarAddress },
        error: null,
      });

      const res = await request(app)
        .post('/subscriptions')
        .send({
          plan_id: validPlanId,
          customer_wallet_address: validStellarAddress,
        });

      expect(res.status).toBe(201);
      expect(res.body.message).toBe('Subscription created');
      expect(mockSupabase.from).toHaveBeenCalledWith('subscriptions');
    });

    it('rejects an invalid Stellar public address with 400', async () => {
      const res = await request(app)
        .post('/subscriptions')
        .send({
          plan_id: validPlanId,
          customer_wallet_address: 'invalid-stellar-key-12345',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('customer_wallet_address');
    });

    it('rejects invalid plan_id UUID with 400', async () => {
      const res = await request(app)
        .post('/subscriptions')
        .send({
          plan_id: 'not-a-uuid',
          customer_wallet_address: validStellarAddress,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('plan_id');
    });

    it('returns 404 when the plan does not exist', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: null,
        error: { code: '23503', message: 'insert or update on table "subscriptions" violates foreign key constraint' },
      });

      const res = await request(app)
        .post('/subscriptions')
        .send({
          plan_id: validPlanId,
          customer_wallet_address: validStellarAddress,
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Plan not found');
    });
  });

  // ==========================================
  // POST /trigger-pull
  // ==========================================
  describe('POST /trigger-pull', () => {
    it('returns 400 when subscription_id is missing', async () => {
      const res = await request(app).post('/trigger-pull').set('Authorization', apiKey.header).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('subscription_id');
    });

    it('rejects merchant secrets instead of accepting or storing them', async () => {
      const res = await request(app)
        .post('/trigger-pull')
        .set('Authorization', apiKey.header)
        .send({ subscription_id: validSubscriptionId, merchant_secret: 'must-never-leave-the-wallet' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('input');
    });

    it('returns 404 when the subscription does not exist', async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
      });

      const res = await request(app)
        .post('/trigger-pull')
        .set('Authorization', apiKey.header)
        .send({ subscription_id: validSubscriptionId });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Subscription not found');
    });

    it("returns 404 for a subscription owned by another merchant", async () => {
      mockSupabase.single.mockResolvedValueOnce({
        data: {
          id: validSubscriptionId,
          customer_wallet_address: validStellarAddress,
          plans: { merchant_id: '00000000-0000-4000-8000-000000000000', usdc_amount: 290000000, interval_seconds: 2592000 },
        },
        error: null,
      });

      const res = await request(app)
        .post('/trigger-pull')
        .set('Authorization', apiKey.header)
        .send({ subscription_id: validSubscriptionId });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Subscription not found');
    });

    describe('wallet-signed transaction flow', () => {
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

      const prepareAndSign = async () => {
        const prepared = await request(app).post('/trigger-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId });
        expect(prepared.status).toBe(200);
        expect(mockServer.sendTransaction).not.toHaveBeenCalled();
        const transaction = TransactionBuilder.fromXDR(prepared.body.transaction_xdr, Networks.TESTNET);
        transaction.sign(merchantKeypair);
        return transaction.toXDR();
      };

      it('advances next_billing_date only after the transaction is confirmed SUCCESS', async () => {
        mockServer.getTransaction.mockResolvedValue({ status: 'SUCCESS' });
        const signed_xdr = await prepareAndSign();
        const res = await request(app)
          .post('/submit-pull')
          .set('Authorization', apiKey.header)
          .send({ subscription_id: validSubscriptionId, signed_xdr });

        expect(res.status).toBe(200);
        expect(res.body.txHash).toBe('deadbeef');
        expect(mockSupabase.update).toHaveBeenCalledWith(
          expect.objectContaining({ next_billing_date: expect.any(String) })
        );
      });

      it('marks the subscription past_due and returns an error when the transaction fails', async () => {
        mockServer.getTransaction.mockResolvedValue({ status: 'FAILED' });
        const signed_xdr = await prepareAndSign();
        const res = await request(app)
          .post('/submit-pull')
          .set('Authorization', apiKey.header)
          .send({ subscription_id: validSubscriptionId, signed_xdr });

        expect(res.status).toBe(502);
        expect(res.body.txHash).toBe('deadbeef');
        expect(mockSupabase.update).toHaveBeenCalledWith({ status: 'past_due' });
      });

      it('returns 202 with the hash when confirmation times out', async () => {
        mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });
        const signed_xdr = await prepareAndSign();
        const res = await request(app)
          .post('/submit-pull')
          .set('Authorization', apiKey.header)
          .send({ subscription_id: validSubscriptionId, signed_xdr });

        expect(res.status).toBe(202);
        expect(res.body.txHash).toBe('deadbeef');
        expect(mockSupabase.update).not.toHaveBeenCalled();
      });

      it('refuses an unsigned transaction', async () => {
        const prepared = await request(app).post('/trigger-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId });
        const res = await request(app).post('/submit-pull').set('Authorization', apiKey.header).send({ subscription_id: validSubscriptionId, signed_xdr: prepared.body.transaction_xdr });
        expect(res.status).toBe(401);
        expect(mockServer.sendTransaction).not.toHaveBeenCalled();
      });
    });
  });
});
