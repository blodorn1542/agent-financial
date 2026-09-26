'use strict';

/**
 * The A/R Aging Detail report, read for the credits the invoice list cannot
 * see. On the live books on 2026-09-26 that was $29,694.02 of unapplied
 * payments (back to 2011) and journal entries, and every caller missed it.
 *
 * Two things are guarded here:
 *
 *   1. Only leaf transactions are read. Bucket headers are labels and Summary
 *      rows are subtotals; reading either as a transaction counts a credit
 *      twice - the detail-report twin of the $562.50 bug in lib/aging.js.
 *   2. Columns are found by what they are, not where they sit, and a report
 *      without Customer or Open Balance is refused, never read as "no credits".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAgingDetailReport, splitOpenCredits, AgingDetailColumnError, createFinancial, METHODS,
} = require('../index');

const fixture = require('./fixtures/aged-receivable-detail.json');

const clone = (o) => JSON.parse(JSON.stringify(o));

/* --------------------------------------------------------------- parsing -- */

test('every leaf transaction is read, and no header or subtotal is', () => {
  const p = parseAgingDetailReport(fixture.report);
  assert.equal(p.rows.length, fixture.expected.rows);
  // Each bucket carries a Summary and the report a GrandTotal. Counting any
  // of them would double the total; the leaf sum is the report's own TOTAL.
  assert.equal(p.total, fixture.expected.total);
  const grand = fixture.report.Rows.Row.find((r) => r.group === 'GrandTotal');
  assert.equal(Number(grand.Summary.ColData.at(-1).value), p.total);
  assert.equal(p.rows.some((r) => /^Total/i.test(r.customerName || '')), false);
});

test('a row carries the customer id, the transaction and its dates', () => {
  const p = parseAgingDetailReport(fixture.report);
  const old = p.rows.find((r) => r.date === '2022-06-01');
  assert.deepEqual(old, {
    customerId: '344', customerName: 'Plains Family:344 Example Plains',
    txnType: 'Payment', txnId: '3101', docNumber: null,
    date: '2022-06-01', dueDate: '2022-06-01', amount: -6100, openBalance: -6100,
    section: '91 or more days past due',
  });
});

test('a sub-customer keeps its "Parent:Child" name, and its own id', () => {
  const p = parseAgingDetailReport(fixture.report);
  const ross = p.rows.find((r) => r.txnId === '6601');
  assert.equal(ross.customerName, 'Ross Family:3 Example Drive');
  assert.equal(ross.customerId, '41');
});

test('a customer cell with no id falls back to the name, and says so with a null id', () => {
  const p = parseAgingDetailReport(fixture.report);
  const named = p.rows.find((r) => r.customerName === 'Name Only Customer');
  assert.equal(named.customerId, null);
  assert.equal(named.openBalance, 400);
  assert.equal(named.amount, 1000);
});

test('columns are found by key or by title, never by position', () => {
  // Reverse the columns and every row's cells: same answer.
  const r = clone(fixture.report);
  r.Columns.Column.reverse();
  const flip = (rows) => {
    for (const row of rows || []) {
      if (Array.isArray(row.ColData)) row.ColData.reverse();
      flip(row.Rows?.Row);
    }
  };
  flip(r.Rows.Row);
  assert.deepEqual(parseAgingDetailReport(r).rows, parseAgingDetailReport(fixture.report).rows);

  // No keys at all - generic ColTypes, no MetaData: titles still find them.
  const t = clone(fixture.report);
  for (const c of t.Columns.Column) { c.ColType = 'Money'; delete c.MetaData; }
  assert.equal(parseAgingDetailReport(t).total, fixture.expected.total);

  // A localized title with the documented key: Intuit's own sample titles the
  // customer column "Client".
  const k = clone(fixture.report);
  const cust = k.Columns.Column.find((c) => c.ColTitle === 'Customer');
  cust.ColTitle = 'Client'; cust.ColType = 'cust_name'; delete cust.MetaData;
  assert.equal(parseAgingDetailReport(k).rows[0].customerId, '58');
});

test('a report without an Open Balance column is refused, not read as zero credits', () => {
  // Intuit's documented sample, cut down: columns=cust_name,due_date only.
  const sample = {
    Header: { ReportName: 'AgedReceivableDetail', EndPeriod: '2015-06-30' },
    Rows: { Row: [{
      Header: { ColData: [{ value: '31 - 60 days past due' }, { value: '' }] },
      Rows: { Row: [{ ColData: [{ id: '8', value: 'Freeman Sporting Goods:0969 Ocean View Road' }, { value: '2015-05-24' }], type: 'Data' }] },
      type: 'Section',
    }, {
      Header: { ColData: [{ value: 'Total for 31 - 60 days past due' }, { value: '' }] }, Rows: {}, type: 'Section',
    }] },
    Columns: { Column: [{ ColType: 'cust_name', ColTitle: 'Client' }, { ColType: 'due_date', ColTitle: 'Due Date' }] },
  };
  assert.throws(() => parseAgingDetailReport(sample), (err) => {
    assert.ok(err instanceof AgingDetailColumnError);
    assert.equal(err.name, 'AgingDetailColumnError');
    assert.deepEqual(err.missing, ['Open Balance']);
    assert.match(err.message, /"Client", "Due Date"/);
    return true;
  });
});

test('a report without a Customer column is refused too', () => {
  const r = clone(fixture.report);
  const c = r.Columns.Column.find((x) => x.ColTitle === 'Customer');
  c.ColTitle = 'Memo'; c.MetaData = [{ Name: 'ColKey', Value: 'memo' }];
  assert.throws(() => parseAgingDetailReport(r), /no Customer column/);
  assert.throws(() => parseAgingDetailReport({}), /no Customer or Open Balance column/);
});

test('an empty report is no rows, not an error', () => {
  const r = clone(fixture.report);
  r.Rows = {};
  r.Header.Option = [{ Name: 'NoReportData', Value: 'true' }];
  const p = parseAgingDetailReport(r);
  assert.deepEqual(p.rows, []);
  assert.equal(p.total, 0);
});

/* ------------------------------------------------------------- splitting -- */

test('credits are every negative open balance, of any type, as a positive amount', () => {
  const { credits, charges, totals } = splitOpenCredits(parseAgingDetailReport(fixture.report).rows);
  assert.equal(totals.credits, fixture.expected.credits);
  assert.equal(totals.creditCount, fixture.expected.creditCount);
  assert.deepEqual([...new Set(credits.map((c) => c.txnType))].sort(),
    ['Credit Memo', 'Journal Entry', 'Payment']);
  for (const c of credits) assert.ok(c.openBalance > 0, 'a credit is reported as an amount held');
  const je = credits.find((c) => c.txnType === 'Journal Entry');
  assert.equal(je.openBalance, 660.11);

  // The +$496.59 journal-entry charge is A/R, but it is not an invoice.
  assert.equal(charges.length, 1);
  assert.equal(charges[0].txnType, 'Journal Entry');
  assert.equal(charges[0].openBalance, 496.59);
  assert.equal(totals.invoices, fixture.expected.invoices);

  // The three parts add back up to the report.
  assert.equal(Math.round((totals.invoices + totals.charges - totals.credits) * 100) / 100, fixture.expected.total);
});

/* ------------------------------------------------------ through the API -- */

function money(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), body: init.body });
    return handler(String(url));
  };
  const layer = createFinancial({
    credentials: {
      get: () => ({
        realm_id: 'REALM-TEST-1', access_token: 'a', refresh_token: 'r',
        access_expires_at: Date.now() + 3600e3, refresh_expires_at: Date.now() + 100 * 86400e3,
      }),
      save: () => {}, remove: () => {},
    },
    fetchImpl,
    quickbooks: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.com/cb' },
  });
  return { layer, calls };
}

const json = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });

test('getOpenCredits is on the allow-list and reads the detail report with a GET', async () => {
  assert.ok(METHODS.includes('getOpenCredits'));
  const { layer, calls } = money((u) => {
    if (u.includes('/reports/AgedReceivableDetail')) return json(fixture.report);
    throw new Error('unexpected request: ' + u);
  });
  const out = await layer.getOpenCredits({ tenant: 'elite-pools', asOf: '2026-09-26', basis: 'Accrual' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, undefined);
  assert.match(calls[0].url, /\/v3\/company\/REALM-TEST-1\/reports\/AgedReceivableDetail\?/);
  assert.match(calls[0].url, /report_date=2026-09-26/);
  assert.match(calls[0].url, /accounting_method=Accrual/);
  // Default columns: asking for columns explicitly could drop Open Balance.
  assert.doesNotMatch(calls[0].url, /columns=/);

  assert.equal(out.asOf, '2026-09-26');
  assert.equal(out.credits.length, fixture.expected.creditCount);
  assert.equal(out.charges.length, fixture.expected.chargeCount);
  assert.equal(out.totals.credits, fixture.expected.credits);
  assert.equal(out.totals.report, fixture.expected.total);
});

test('without an as-of date the report\'s own end date is used', async () => {
  const { layer, calls } = money(() => json(fixture.report));
  const out = await layer.getOpenCredits({ tenant: 'elite-pools' });
  assert.doesNotMatch(calls[0].url, /report_date=/);
  assert.equal(out.asOf, fixture.report.Header.EndPeriod);
});

test('a report the parser cannot trust rejects with the named error', async () => {
  const bad = clone(fixture.report);
  bad.Columns.Column = bad.Columns.Column.filter((c) => c.ColTitle !== 'Open Balance');
  const { layer } = money(() => json(bad));
  await assert.rejects(() => layer.getOpenCredits({ tenant: 'elite-pools' }),
    (err) => err.name === 'AgingDetailColumnError');
});
