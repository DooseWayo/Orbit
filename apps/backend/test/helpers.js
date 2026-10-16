import { generateApiKey } from '../apiKeys.js';

// Builds a valid API key plus the api_keys row (with joined merchant) the auth lookup returns
export const makeApiKey = ({ merchantId, walletAddress, environment = 'test', ...overrides }) => {
  const { secret, prefix, hash } = generateApiKey(environment);
  const row = {
    id: '9c3e1b52-7d4a-4f8e-b1a2-c3d4e5f60718',
    merchant_id: merchantId,
    name: 'Test key',
    key_prefix: prefix,
    key_hash: hash,
    environment,
    // Recent, so the throttled last_used_at write does not fire and disturb mock call assertions
    last_used_at: new Date().toISOString(),
    revoked_at: null,
    merchants: { id: merchantId, name: 'Acme', wallet_address: walletAddress },
    ...overrides,
  };
  return { secret, header: `Bearer ${secret}`, row };
};
