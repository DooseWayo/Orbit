// Issues an API key for a merchant directly against the database.
// Used to bootstrap a merchant's first key; further keys can be created via POST /api-keys.
//
//   npm run create-api-key -- <merchant_id> "<key name>" [live|test]
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { API_KEY_ENVIRONMENTS, issueApiKey } = require('../apiKeys');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const main = async () => {
    const [merchantId, name, environment = 'test'] = process.argv.slice(2);
    if (!merchantId || !UUID_PATTERN.test(merchantId) || !name?.trim() || !API_KEY_ENVIRONMENTS.includes(environment)) {
        console.error('Usage: npm run create-api-key -- <merchant_id> "<key name>" [live|test]');
        process.exit(1);
    }

    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
        process.exit(1);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { apiKey, secret, error } = await issueApiKey(supabase, { merchantId, name: name.trim(), environment });
    if (error) {
        console.error('Failed to create API key:', error.message);
        process.exit(1);
    }

    console.log(`Created ${apiKey.environment} key "${apiKey.name}" (${apiKey.key_prefix}, id ${apiKey.id})`);
    console.log('Store this secret now; it is not saved and will not be shown again:\n');
    console.log(secret);
};

main();
