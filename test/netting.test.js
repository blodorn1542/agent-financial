'use strict';

/**
 * The netting gap.
 *
 * QuickBooks' aging report is an A/R balance: an unapplied credit memo, or
 * money paid on account and not yet applied, has already reduced it. A sum of
 * open invoices has not. Comparing the two answers a different question on each
 * side, and on real books that produces a diff that never closes however
 * correct both sides are.
 *
 * The Intuit sandbox holds no unapplied credits, which is why this went
 * unnoticed there for so long - diff $0.00 was the truth about a company with
 * nothing to net, not evidence that netting worked. These tests build the case
 * the sandbox cannot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcile, createFinancial } = require('../index');

const COLUMNS = ['', 'Current', '1 - 30', '31 - 60', '61 - 90', '91 and over', 'Total'];

/** An aging report with the given per-customer totals, in the 91+ bucket. */
function reportOf(rows) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  return {
    Header: { ReportName: 'AgedReceivables', ReportBasis: 'Accrual' },
    Columns: { Column: COLUMNS.map((c) => ({ ColTitle: c })) },
    Rows: { Row: [
      ...rows.map((r) => ({ ColData: [
        { value: r.name, id: r.id }, { value: '' }, { value: '' }, { value: '' },
        { value: '' }, { value: r.total.toFixed(2) }, { value: r.total.toFixed(2) },
      ] })),
      { type: 'Section', group: 'GrandTotal', Summary: { ColData: [
        { value: 'TOTAL' }, { value: '' }, { value: '' }, { value: '' },
        { value: '' }, { value: total.toFixed(2) }, { value: total.toFixed(2) },
      ] } },
    ] },
  };
}

function invoice(id, customerId, name, balance) {
  return { Id: id, DocNumber: id, CustomerRef: { value: customerId, name }, Balance: balance };
}

/* ------------------------------------------------------- the phantom diff -- */

test('an unapplied credit memo no longer shows up as a permanent diff', () => {
  // Acme has $1,000 of open invoices and a $250 credit they have not spent.
  // QuickBooks reports $750 owed, because that is what they owe.
  const invoices = [invoice('1', '10', 'Acme', 1000)];
  const creditMemos = [{ Id: 'CM1', CustomerRef: { value: '10', name: 'Acme' }, Balance: 250 }];
  const report = reportOf([{ id: '10', name: 'Acme', total: 750 }]);

  // Before the fix: $1,000 against $750, a $250 gap that no amount of correct
  // arithmetic on either side would ever close.
  const ungated = reconcile({ invoices, report });
  assert.equal(ungated.diff, 250, 'the gross comparison should still disagree');

  const out = reconcile({ invoices, creditMemos, report });
  assert.equal(out.invoiceTotal, 1000);
  assert.equal(out.creditTotal, 250);
  assert.equal(out.netTotal, 750);
  assert.equal(out.reportTotal, 750);
  assert.equal(out.diff, 0);
  assert.equal(out.mismatched, 0);
  assert.equal(out.matched, 1);
});

test('unapplied payments net the same way', () => {
  const invoices = [invoice('1', '10', 'Acme', 1000)];
  const payments = [{ Id: 'P1', CustomerRef: { value: '10', name: 'Acme' }, UnappliedAmt: 400, TotalAmt: 900 }];
  const report = reportOf([{ id: '10', name: 'Acme', total: 600 }]);

  const out = reconcile({ invoices, payments, report });
  assert.equal(out.unappliedPaymentTotal, 400);
  assert.equal(out.netTotal, 600);
  assert.equal(out.diff, 0);
});

test('an applied payment is not netted twice', () => {
  // TotalAmt 900 but nothing unapplied: that money already came off the invoice
  // balances. Subtracting it again would invent a credit nobody holds.
  const invoices = [invoice('1', '10', 'Acme', 100)];
  const payments = [{ Id: 'P1', CustomerRef: { value: '10', name: 'Acme' }, UnappliedAmt: 0, TotalAmt: 900 }];
  const report = reportOf([{ id: '10', name: 'Acme', total: 100 }]);

  const out = reconcile({ invoices, payments, report });
  assert.equal(out.unappliedPaymentTotal, 0);
  assert.equal(out.netTotal, 100);
  assert.equal(out.diff, 0);
});

test('a customer holding only a credit is not invisible', () => {
  // No open invoices at all, just a credit. Before the fix this customer had no
  // entry on our side, so the report's negative row had nothing to pair with.
  const creditMemos = [{ Id: 'CM1', CustomerRef: { value: '11', name: 'Beta' }, Balance: 300 }];
  const report = reportOf([{ id: '11', name: 'Beta', total: -300 }]);

  const out = reconcile({ invoices: [], creditMemos, report });
  const beta = out.rows.find((r) => r.customerId === '11');
  assert.ok(beta, 'the customer must appear even with no invoices');
  assert.equal(beta.invoiceTotal, 0);
  assert.equal(beta.credits, 300);
  assert.equal(beta.netTotal, -300);
  assert.equal(beta.diff, 0);
  assert.equal(out.diff, 0);
});

test('netting is per customer - one credit cannot silence another\'s gap', () => {
  // Acme's credit closes Acme's gap. Beta is genuinely short and must still say so.
  const invoices = [invoice('1', '10', 'Acme', 1000), invoice('2', '11', 'Beta', 500)];
  const creditMemos = [{ Id: 'CM1', CustomerRef: { value: '10', name: 'Acme' }, Balance: 250 }];
  const report = reportOf([
    { id: '10', name: 'Acme', total: 750 },
    { id: '11', name: 'Beta', total: 400 },
  ]);

  const out = reconcile({ invoices, creditMemos, report });
  const byId = Object.fromEntries(out.rows.map((r) => [r.customerId, r]));
  assert.equal(byId['10'].diff, 0, "Acme's credit should close Acme's gap");
  assert.equal(byId['11'].diff, 100, "Beta's real gap must survive");
  assert.equal(out.mismatched, 1);
  assert.equal(out.diff, 100);
});

test('the gross invoice total is still reported, not replaced', () => {
  // Whoever is chasing the money still needs to know the invoices say $1,000,
  // even though only $750 is owed.
  const out = reconcile({
    invoices: [invoice('1', '10', 'Acme', 1000)],
    creditMemos: [{ Id: 'CM1', CustomerRef: { value: '10', name: 'Acme' }, Balance: 250 }],
    report: reportOf([{ id: '10', name: 'Acme', total: 750 }]),
  });
  assert.equal(out.invoiceTotal, 1000);
  assert.equal(out.rows[0].invoiceTotal, 1000);
  assert.equal(out.rows[0].netTotal, 750);
});

test('with nothing to net, every number is exactly what it was before', () => {
  const sandbox = require('./fixtures/sandbox-aging.json');
  const out = reconcile({ invoices: sandbox.invoices, creditMemos: [], payments: [], report: sandbox.report });
  assert.deepEqual({
    invoiceTotal: out.invoiceTotal, reportTotal: out.reportTotal, diff: out.diff,
    customersInInvoices: out.customersInInvoices, customersInReport: out.customersInReport,
    matched: out.matched, mismatched: out.mismatched,
  }, sandbox.expected);
  assert.equal(out.creditTotal, 0);
  assert.equal(out.netTotal, out.invoiceTotal);
});

/* ------------------------------------------------------- through the API -- */

function stub(handlers) {
  return async (url) => {
    const u = decodeURIComponent(String(url));
    const json = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
    if (u.includes('/reports/AgedReceivables')) return json(handlers.report);
    if (/FROM Invoice WHERE Balance/.test(u)) return json({ QueryResponse: { Invoice: handlers.invoices } });
    if (/FROM CreditMemo/.test(u)) return json({ QueryResponse: { CreditMemo: handlers.creditMemos || [] } });
    if (/FROM Payment/.test(u)) return json({ QueryResponse: { Payment: handlers.payments || [] } });
    throw new Error('unexpected request: ' + u);
  };
}

function money(handlers) {
  return createFinancial({
    credentials: {
      get: () => ({
        realm_id: 'REALM-TEST-1', access_token: 'a', refresh_token: 'r',
        access_expires_at: Date.now() + 3600e3, refresh_expires_at: Date.now() + 100 * 86400e3,
      }),
      save: () => {}, remove: () => {},
    },
    fetchImpl: stub(handlers),
    quickbooks: { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://example.com/cb' },
  });
}

test('getArAging fetches credit memos itself and reports the composition', async () => {
  const aging = await money({
    invoices: [invoice('1', '10', 'Acme', 1000)],
    creditMemos: [{ Id: 'CM1', CustomerRef: { value: '10', name: 'Acme' }, Balance: 250 }],
    report: reportOf([{ id: '10', name: 'Acme', total: 750 }]),
  }).getArAging({ tenant: 'sandbox' });

  assert.equal(aging.reconciled, true);
  assert.equal(aging.reconciliation.invoiceTotal, 1000);
  assert.equal(aging.reconciliation.creditTotal, 250);
  assert.equal(aging.reconciliation.netTotal, 750);
  assert.equal(aging.reconciliation.diff, 0);
});

test('a caller that does not deal with payments is told so, not left guessing', async () => {
  const aging = await money({
    invoices: [invoice('1', '10', 'Acme', 1000)],
    report: reportOf([{ id: '10', name: 'Acme', total: 1000 }]),
  }).getArAging({ tenant: 'sandbox' });
  assert.match(aging.reconciliation.paymentsWindow, /not netted/);
});

test('naming a payments window nets them and says which window', async () => {
  const aging = await money({
    invoices: [invoice('1', '10', 'Acme', 1000)],
    payments: [{ Id: 'P1', CustomerRef: { value: '10', name: 'Acme' }, UnappliedAmt: 400, TotalAmt: 400 }],
    report: reportOf([{ id: '10', name: 'Acme', total: 600 }]),
  }).getArAging({ tenant: 'sandbox', paymentsSince: '2026-01-01' });

  assert.equal(aging.reconciliation.unappliedPaymentTotal, 400);
  assert.equal(aging.reconciliation.diff, 0);
  assert.equal(aging.reconciliation.paymentsWindow, 'since 2026-01-01');
});
