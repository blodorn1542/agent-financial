'use strict';

/**
 * The QuickBooks adapter. Two things are being guarded here:
 *
 *   1. It reads and only reads. Not "we checked and there are no write
 *      methods" - every request it makes during a full sweep is recorded and
 *      asserted to be a GET against the company file.
 *   2. It uses the host's credential storage. That is what lets an already
 *      authorized company survive this code moving into a package, which the
 *      spec asked for in as many words: don't force a re-auth.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFinancial } = require('../index');
const quickbooks = require('../lib/adapters/quickbooks');
const { createCredentials } = require('../lib/credentials');

const sandbox = require('./fixtures/sandbox-aging.json');

const SETTINGS = { clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://example.com/cb' };

function memoryCredentials(seed = {}) {
  const rows = { ...seed };
  return {
    get: (t, p) => rows[t + '/' + p] ?? null,
    save: (t, p, tok) => { rows[t + '/' + p] = toRow(tok); },
    remove: (t, p) => { delete rows[t + '/' + p]; },
    _rows: rows,
  };
}

function toRow(tok) {
  return {
    realm_id: tok.realmId ?? null,
    access_token: tok.accessToken ?? null,
    refresh_token: tok.refreshToken ?? null,
    access_expires_at: tok.accessExpiresAt ?? null,
    refresh_expires_at: tok.refreshExpiresAt ?? null,
  };
}

function live(realmId = 'REALM-1') {
  return {
    realm_id: realmId,
    access_token: 'access-live',
    refresh_token: 'refresh-live',
    access_expires_at: Date.now() + 60 * 60 * 1000,
    refresh_expires_at: Date.now() + 100 * 24 * 60 * 60 * 1000,
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function recorder(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), init });
    return handler(String(url), init);
  };
  impl.calls = calls;
  return impl;
}

function replaySandbox(url) {
  if (url.includes('/reports/AgedReceivables')) return jsonResponse(sandbox.report);
  if (url.includes('/companyinfo/')) return jsonResponse({ CompanyInfo: { CompanyName: 'Sandbox Company_US_1' } });
  if (url.includes('/query')) {
    const q = decodeURIComponent(url.split('query=')[1] || '');
    if (/FROM Invoice WHERE Balance/.test(q)) return jsonResponse({ QueryResponse: { Invoice: sandbox.invoices } });
    if (/FROM CreditMemo/.test(q)) return jsonResponse({ QueryResponse: { CreditMemo: [] } });
    if (/FROM Payment/.test(q)) return jsonResponse({ QueryResponse: { Payment: [] } });
    if (/FROM Customer/.test(q)) return jsonResponse({ QueryResponse: { Customer: [] } });
    if (/FROM Invoice WHERE TxnDate/.test(q)) return jsonResponse({ QueryResponse: { Invoice: [] } });
  }
  throw new Error('unexpected request: ' + url);
}

/* ---------------------------------------------------------- read-only -- */

test('a full sweep of every read issues nothing but GETs at the company file', async () => {
  const fetchImpl = recorder(replaySandbox);
  const money = createFinancial({
    credentials: memoryCredentials({ 'sandbox/quickbooks': live() }),
    fetchImpl, quickbooks: SETTINGS,
  });

  await money.getArAging({ tenant: 'sandbox' });
  await money.getOpenInvoices({ tenant: 'sandbox' });
  await money.getOpenCreditMemos({ tenant: 'sandbox' });
  await money.getPaymentsSince({ tenant: 'sandbox', date: '2026-09-01' });
  await money.getInvoicesSince({ tenant: 'sandbox', date: '2026-01-01' });
  await money.getCustomers({ tenant: 'sandbox' });
  await money.getCompanyInfo({ tenant: 'sandbox' });

  const books = fetchImpl.calls.filter((c) => c.url.includes('/v3/company/'));
  assert.ok(books.length >= 8, 'expected the sweep to actually hit the company file');
  for (const c of books) {
    assert.equal(c.method, 'GET', 'non-GET at the company file: ' + c.method + ' ' + c.url);
    assert.equal(c.init.body, undefined, 'a request carried a body: ' + c.url);
  }
});

test('the path to the company file takes no method, so it cannot be made to write', () => {
  const adapter = quickbooks.create({ credentials: memoryCredentials(), fetchImpl: async () => {}, settings: SETTINGS });
  // Each read is get(tenantId, path) or get(tenantId, path, options) - never a verb.
  for (const [name, fn] of Object.entries(adapter.reads)) {
    assert.ok(fn.length <= 2, name + ' takes ' + fn.length + ' arguments; a read takes a tenant and at most one option');
  }
});

/* ------------------------------------------------------- credentials -- */

test('an already-authorized company is read from the host\'s own storage', async () => {
  // Exactly the situation the move had to survive: the row already exists,
  // written by the host long before this package did.
  const creds = memoryCredentials({ 'sandbox/quickbooks': live('REALM-TEST-1') });
  const fetchImpl = recorder(replaySandbox);
  const money = createFinancial({ credentials: creds, fetchImpl, quickbooks: SETTINGS });

  await money.getOpenInvoices({ tenant: 'sandbox' });

  const call = fetchImpl.calls.at(-1);
  assert.match(call.url, /\/v3\/company\/REALM-TEST-1\//);
  assert.equal(call.init.headers.Authorization, 'Bearer access-live');
  // Nothing was re-saved: no token endpoint was touched at all.
  assert.equal(fetchImpl.calls.some((c) => c.url.includes('oauth')), false);
});

test('a host that names the company file external_id is understood too', async () => {
  const creds = memoryCredentials({ 'sandbox/quickbooks': { ...live(), realm_id: null, external_id: 'EXT-9' } });
  const fetchImpl = recorder(replaySandbox);
  const money = createFinancial({ credentials: creds, fetchImpl, quickbooks: SETTINGS });
  await money.getCustomers({ tenant: 'sandbox' });
  assert.match(fetchImpl.calls.at(-1).url, /\/v3\/company\/EXT-9\//);
});

test('a rotated refresh token is persisted, or the tenant falls off in 100 days', async () => {
  const creds = memoryCredentials({
    'sandbox/quickbooks': { ...live(), access_expires_at: Date.now() - 1000 }, // stale
  });
  const fetchImpl = recorder((url) => {
    if (url.includes('tokens/bearer')) {
      return jsonResponse({
        access_token: 'access-NEW', refresh_token: 'refresh-ROTATED',
        expires_in: 3600, x_refresh_token_expires_in: 8726400,
      });
    }
    return replaySandbox(url);
  });
  const money = createFinancial({ credentials: creds, fetchImpl, quickbooks: SETTINGS });

  await money.getCustomers({ tenant: 'sandbox' });

  assert.equal(creds._rows['sandbox/quickbooks'].refresh_token, 'refresh-ROTATED');
  assert.equal(creds._rows['sandbox/quickbooks'].access_token, 'access-NEW');
  assert.match(fetchImpl.calls.at(-1).init.headers.Authorization, /Bearer access-NEW/);
});

test('an Intuit response that omits the refresh token keeps the old one', async () => {
  const creds = memoryCredentials({
    'sandbox/quickbooks': { ...live(), access_expires_at: Date.now() - 1000 },
  });
  const fetchImpl = recorder((url) => url.includes('tokens/bearer')
    ? jsonResponse({ access_token: 'access-NEW', expires_in: 3600 })
    : replaySandbox(url));
  const money = createFinancial({ credentials: creds, fetchImpl, quickbooks: SETTINGS });

  await money.getCustomers({ tenant: 'sandbox' });
  assert.equal(creds._rows['sandbox/quickbooks'].refresh_token, 'refresh-live');
});

test('an expired refresh token says so instead of failing at Intuit', async () => {
  const creds = memoryCredentials({
    'sandbox/quickbooks': { ...live(), refresh_expires_at: Date.now() - 1000 },
  });
  const money = createFinancial({ credentials: creds, fetchImpl: recorder(replaySandbox), quickbooks: SETTINGS });
  await assert.rejects(() => money.getCustomers({ tenant: 'sandbox' }), /refresh token has expired/);
});

test('a credentials port missing a method is refused at construction', () => {
  assert.throws(
    () => createFinancial({ credentials: { get() {}, save() {} }, quickbooks: SETTINGS }),
    /credentials port is missing remove\(\)/,
  );
});

test('the default credentials table is namespaced, so it can share a host database', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE tenants (tenant_id TEXT PRIMARY KEY);'); // a host table
  createCredentials(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(names.includes('tenants'), 'the host table must survive untouched');
  assert.deepEqual(names.filter((n) => n !== 'tenants' && !n.startsWith('sqlite_')), ['financial_connections']);
  db.close();
});

/* --------------------------------------------------------------- OAuth -- */

test('the consent URL asks for accounting scope and nothing more', () => {
  const adapter = quickbooks.create({ credentials: memoryCredentials(), fetchImpl: async () => {}, settings: SETTINGS });
  const url = new URL(adapter.auth.authorizeUrl('state-123'));
  assert.equal(url.searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  assert.equal(url.searchParams.get('client_id'), 'client-id');
  assert.equal(url.searchParams.get('state'), 'state-123');
  assert.equal(url.searchParams.get('response_type'), 'code');
  // No payments scope, no openid - this connector has no business with either.
  assert.equal(/payment|openid|profile|email/i.test(url.searchParams.get('scope')), false);
});

test('a missing Intuit credential is named, not swallowed', () => {
  const adapter = quickbooks.create({ credentials: memoryCredentials(), fetchImpl: async () => {}, settings: {} });
  const saved = { id: process.env.QBO_CLIENT_ID, redirect: process.env.QBO_REDIRECT_URI };
  delete process.env.QBO_CLIENT_ID;
  delete process.env.QBO_REDIRECT_URI;
  try {
    assert.throws(() => adapter.auth.authorizeUrl('s'), /Missing required env var QBO_CLIENT_ID/);
  } finally {
    if (saved.id !== undefined) process.env.QBO_CLIENT_ID = saved.id;
    if (saved.redirect !== undefined) process.env.QBO_REDIRECT_URI = saved.redirect;
  }
});

test('sandbox and production are different hosts, and sandbox is the default', () => {
  const creds = memoryCredentials();
  const sand = quickbooks.create({ credentials: creds, fetchImpl: async () => {}, settings: SETTINGS });
  const prod = quickbooks.create({ credentials: creds, fetchImpl: async () => {}, settings: { ...SETTINGS, env: 'production' } });
  assert.equal(sand.apiBase(), 'https://sandbox-quickbooks.api.intuit.com');
  assert.equal(prod.apiBase(), 'https://quickbooks.api.intuit.com');
});

test('a query pages until a short page arrives', async () => {
  const page1 = Array.from({ length: 500 }, (_, i) => ({ Id: String(i + 1), Balance: 1 }));
  const page2 = [{ Id: '501', Balance: 1 }];
  const fetchImpl = recorder((url) => {
    const q = decodeURIComponent(url.split('query=')[1] || '');
    return jsonResponse({ QueryResponse: { Invoice: /STARTPOSITION 1 /.test(q) ? page1 : page2 } });
  });
  const money = createFinancial({
    credentials: memoryCredentials({ 'sandbox/quickbooks': live() }), fetchImpl, quickbooks: SETTINGS,
  });
  const invoices = await money.getOpenInvoices({ tenant: 'sandbox' });
  assert.equal(invoices.length, 501);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a QuickBooks error carries the status and the endpoint, not just "failed"', async () => {
  const fetchImpl = recorder(async () => ({ ok: false, status: 403, text: async () => 'AuthorizationFailure' }));
  const money = createFinancial({
    credentials: memoryCredentials({ 'sandbox/quickbooks': live() }), fetchImpl, quickbooks: SETTINGS,
  });
  await assert.rejects(() => money.getCustomers({ tenant: 'sandbox' }),
    /QuickBooks 403 on \/query.*AuthorizationFailure/s);
});
