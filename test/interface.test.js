'use strict';

/**
 * The interface's job is to be read-only and to hand every agent the same
 * reconciled answer. Each test below guards one of those two properties; if
 * someone loosens either, one of these fails loudly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createFinancial, assertReadOnly, normalizeBuckets, METHODS,
} = require('../index');
const { createInterface } = require('../lib/interface');

const sandbox = require('./fixtures/sandbox-aging.json');

/** A credentials port backed by a plain object, so no database is needed. */
function memoryCredentials(seed = {}) {
  const rows = { ...seed };
  return {
    get: (t, p) => rows[t + '/' + p] ?? null,
    save: (t, p, tok) => {
      rows[t + '/' + p] = {
        realm_id: tok.realmId ?? null,
        access_token: tok.accessToken ?? null,
        refresh_token: tok.refreshToken ?? null,
        access_expires_at: tok.accessExpiresAt ?? null,
        refresh_expires_at: tok.refreshExpiresAt ?? null,
      };
    },
    remove: (t, p) => { delete rows[t + '/' + p]; },
    _rows: rows,
  };
}

/** A live-token row, far enough from expiry that nothing tries to refresh. */
function connected(realmId = 'REALM-TEST-1') {
  return {
    realm_id: realmId,
    access_token: 'access-abc',
    refresh_token: 'refresh-abc',
    access_expires_at: Date.now() + 60 * 60 * 1000,
    refresh_expires_at: Date.now() + 100 * 24 * 60 * 60 * 1000,
  };
}

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

/**
 * Replays the captured sandbox books over HTTP, and records every request so a
 * test can assert what was asked for and how.
 */
function recordingFetch() {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    const u = String(url);
    if (u.includes('/reports/AgedReceivables')) return jsonResponse(sandbox.report);
    if (u.includes('/query')) {
      const q = decodeURIComponent(u.split('query=')[1] || '');
      if (/FROM Invoice WHERE Balance/.test(q)) return jsonResponse({ QueryResponse: { Invoice: sandbox.invoices } });
      if (/FROM CreditMemo/.test(q)) return jsonResponse({ QueryResponse: { CreditMemo: [] } });
      if (/FROM Payment/.test(q)) return jsonResponse({ QueryResponse: { Payment: [] } });
      if (/FROM Customer/.test(q)) return jsonResponse({ QueryResponse: { Customer: [{ Id: '1', DisplayName: 'Amy' }] } });
      if (/FROM Invoice WHERE TxnDate/.test(q)) return jsonResponse({ QueryResponse: { Invoice: [] } });
    }
    if (u.includes('/companyinfo/')) return jsonResponse({ CompanyInfo: { CompanyName: 'Sandbox Company_US_1' } });
    throw new Error('unexpected request: ' + u);
  };
  impl.calls = calls;
  return impl;
}

function financial(credentials = memoryCredentials({ 'sandbox/quickbooks': connected() })) {
  const fetchImpl = recordingFetch();
  const money = createFinancial({
    credentials,
    fetchImpl,
    quickbooks: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.com/cb' },
  });
  return { money, fetchImpl, credentials };
}

/* -------------------------------------------------------------- surface -- */

test('the interface is exactly the read surface, and it is frozen shut', () => {
  const { money } = financial();
  for (const m of METHODS) assert.equal(typeof money[m], 'function', m + ' is missing');

  // Nothing that writes, under any of the usual names.
  for (const forbidden of ['createInvoice', 'updateInvoice', 'writeOff', 'postPayment',
    'setBillingStatus', 'sendInvoice', 'voidInvoice', 'deleteCustomer']) {
    assert.equal(money[forbidden], undefined, forbidden + ' must not exist');
  }

  // And none can be bolted on afterwards.
  const frozen = createInterface({ adapters: { quickbooks: { name: 'q', provider: 'q', reads: {} } } });
  assert.equal(Object.isFrozen(frozen), true);
  assert.throws(() => { 'use strict'; frozen.createInvoice = () => {}; }, TypeError);
});

test('an adapter that offers writes is refused at construction', () => {
  assert.throws(
    () => assertReadOnly({ name: 'rogue', reads: {}, writes: { createInvoice() {} } }),
    /read-only by construction/,
  );
});

test('an adapter that disguises a write as a read is refused too', () => {
  for (const name of ['createInvoice', 'updateCustomer', 'postPayment', 'voidInvoice', 'sendReminder']) {
    assert.throws(
      () => assertReadOnly({ name: 'rogue', reads: { [name]() {} } }),
      /reads like a write/,
      name + ' should have been refused',
    );
  }
  // A genuine read passes.
  assert.doesNotThrow(() => assertReadOnly({ name: 'ok', reads: { getOpenInvoices() {} } }));
});

test('the shipped QuickBooks adapter has no writes object at all', () => {
  const { money } = financial();
  assert.equal(money.adapters.quickbooks.writes, undefined);
  assert.deepEqual(Object.keys(money.adapters.quickbooks.reads).filter((k) => !k.startsWith('get')), []);
});

/* ------------------------------------------------------- per-tenant reads -- */

test('every read demands a tenant - there is no global read', async () => {
  const { money } = financial();
  for (const m of METHODS) {
    // The two date-bounded reads get a valid date, so the only thing missing
    // is the tenant and the refusal is unambiguous.
    const args = /Since$/.test(m) ? { date: '2026-01-01' } : {};
    await assert.rejects(() => money[m](args), /every read is per tenant/, m + ' allowed a global read');
  }
});

test('one tenant cannot reach another tenant\'s books', async () => {
  const creds = memoryCredentials({ 'sandbox/quickbooks': connected('REALM-A') });
  const { money } = financial(creds);
  await assert.rejects(
    () => money.getOpenInvoices({ tenant: 'someone-else' }),
    /has not connected QuickBooks yet/,
  );
});

test('an unknown provider is named, not silently defaulted', async () => {
  const { money } = financial();
  await assert.rejects(
    () => money.getCustomers({ tenant: 'sandbox', provider: 'xero' }),
    /No financial adapter named "xero"\. Available: quickbooks/,
  );
});

test('a date-bounded read refuses to run without its date', async () => {
  const { money } = financial();
  await assert.rejects(() => money.getPaymentsSince({ tenant: 'sandbox' }), /needs \{ date \}/);
  await assert.rejects(() => money.getInvoicesSince({ tenant: 'sandbox' }), /needs \{ date \}/);
});

test('a Date is accepted wherever a YYYY-MM-DD string is', async () => {
  const { money, fetchImpl } = financial();
  await money.getPaymentsSince({ tenant: 'sandbox', date: new Date('2026-09-01T00:00:00Z') });
  const q = decodeURIComponent(fetchImpl.calls.at(-1).url);
  assert.match(q, /TxnDate >= '2026-09-01'/);
});

/* --------------------------------------------------------------- aging -- */

test('getArAging returns a reconciled aging, not just a reported one', async () => {
  const { money } = financial();
  const aging = await money.getArAging({ tenant: 'sandbox' });

  assert.equal(aging.tenant, 'sandbox');
  assert.equal(aging.provider, 'quickbooks');
  assert.equal(aging.total, sandbox.expected.reportTotal);
  assert.equal(aging.reconciled, true);
  assert.equal(aging.reconciliation.diff, 0);
  assert.equal(aging.reconciliation.invoiceTotal, sandbox.expected.invoiceTotal);
  assert.equal(aging.reconciliation.mismatched, 0);

  // The spec's promise: per-customer totals add up to the report total.
  const sum = Math.round(aging.customers.reduce((s, c) => s + c.total, 0) * 100) / 100;
  assert.equal(sum, aging.total);
});

test('a disagreement is reported as a disagreement, not smoothed over', async () => {
  // Same report, one invoice quietly larger than the books say.
  const bent = JSON.parse(JSON.stringify(sandbox.invoices));
  bent[0].Balance = bent[0].Balance + 100;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/reports/AgedReceivables')) return jsonResponse(sandbox.report);
    return jsonResponse({ QueryResponse: { Invoice: bent } });
  };
  const money = createFinancial({
    credentials: memoryCredentials({ 'sandbox/quickbooks': connected() }),
    fetchImpl,
    quickbooks: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.com/cb' },
  });

  const aging = await money.getArAging({ tenant: 'sandbox' });
  assert.equal(aging.reconciled, false);
  assert.equal(aging.reconciliation.diff, 100);
  assert.equal(aging.reconciliation.mismatched, 1);
  assert.equal(aging.reconciliation.rows[0].diff, 100); // biggest gap first
});

test('buckets come back on stable keys whatever Intuit titles them', () => {
  assert.deepEqual(
    normalizeBuckets({ Current: 10, '1 - 30': 20, '31 - 60': 30, '61 - 90': 40, '91 and over': 50 }),
    { current: 10, d1_30: 20, d31_60: 30, d61_90: 40, d91_plus: 50 },
  );
  // Spacing and wording drift between report versions; the keys do not.
  assert.deepEqual(
    normalizeBuckets({ current: 1, '1-30': 2, '91+': 3 }),
    { current: 1, d1_30: 2, d31_60: 0, d61_90: 0, d91_plus: 3 },
  );
  // Anything unrecognized is surfaced rather than dropped on the floor.
  assert.deepEqual(normalizeBuckets({ 'Over 120': 7 }).unmapped, { 'Over 120': 7 });
});

test('the original report titles are kept alongside the normalized keys', async () => {
  const { money } = financial();
  const aging = await money.getArAging({ tenant: 'sandbox' });
  const c = aging.customers.find((x) => x.total > 0);
  assert.ok(c.bucketsByTitle, 'the raw bucket titles must survive');
  assert.equal(typeof c.buckets.d91_plus, 'number');
});

test('the basis and as-of date reach the report call', async () => {
  const { money, fetchImpl } = financial();
  await money.getArAging({ tenant: 'sandbox', basis: 'Cash', asOf: '2026-08-31', agingMethod: 'Report_Date' });
  const call = fetchImpl.calls.find((c) => c.url.includes('AgedReceivables'));
  assert.match(call.url, /accounting_method=Cash/);
  assert.match(call.url, /report_date=2026-08-31/);
  assert.match(call.url, /aging_method=Report_Date/);
});
