import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Database Schema & Row Level Security (RLS) Policies', () => {
  const schemaPath = path.resolve(__dirname, '../schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  it('enables Row Level Security on all core tables', () => {
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+merchants\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+plans\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+subscriptions\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
  });

  it('contains no open or public INSERT policies', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*FOR\s+INSERT/i);
  });

  it('contains no open or public UPDATE policies', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*FOR\s+UPDATE/i);
  });

  it('contains no open or public DELETE policies', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*FOR\s+DELETE/i);
  });

  it('enforces default-deny on subscriptions by defining no policies for subscriptions', () => {
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+subscriptions\b/i);
  });

  it('allows public read (SELECT) only on plans and merchants for checkout', () => {
    const selectPolicies = schemaSql.match(/CREATE\s+POLICY[\s\S]*?ON\s+(\w+)\s+FOR\s+SELECT/gi) || [];
    expect(selectPolicies.length).toBe(2);

    expect(schemaSql).toMatch(/CREATE\s+POLICY[\s\S]*?ON\s+merchants\s+FOR\s+SELECT/i);
    expect(schemaSql).toMatch(/CREATE\s+POLICY[\s\S]*?ON\s+plans\s+FOR\s+SELECT/i);
  });

  it('defines merchant-scoped idempotency keys with a TTL', () => {
    const table = schemaSql.match(/CREATE\s+TABLE\s+idempotency_keys\s*\(([\s\S]*?)\n\);/i)?.[1];
    expect(table).toBeDefined();
    expect(table).toMatch(/merchant_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+merchants\(id\)\s+ON\s+DELETE\s+CASCADE/i);
    expect(table).toMatch(/request_hash\s+VARCHAR\(64\)\s+NOT\s+NULL/i);
    expect(table).toMatch(/expires_at\s+TIMESTAMP\s+WITH\s+TIME\s+ZONE\s+NOT\s+NULL/i);
    expect(table).toMatch(/UNIQUE\s*\(\s*merchant_id\s*,\s*key\s*\)/i);
  });

  it('keeps idempotency and lock tables private to the backend', () => {
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+idempotency_keys\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).toMatch(/ALTER\s+TABLE\s+billing_locks\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY;/i);
    expect(schemaSql).not.toMatch(/CREATE\s+POLICY\s+.*ON\s+(idempotency_keys|billing_locks)\b/i);
    for (const fn of ['claim_idempotency_key', 'acquire_billing_lock', 'release_billing_lock']) {
      expect(schemaSql).toMatch(new RegExp(`REVOKE\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+${fn}\\(`, 'i'));
    }
  });
});
