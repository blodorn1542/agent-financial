'use strict';

/**
 * Income for a window, from the Profit and Loss report (lib/profit-and-loss.js
 * and getIncome on the interface). What is being guarded:
 *
 *   1. The figure is the Income section's Total Income, found by group or
 *      label, never by row position - and a report with no Income section is
 *      refused rather than read as $0.
 *   2. The read asks Intuit for exactly the window and basis it was given,
 *      as a GET, and refuses a window it was not given.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFinancial, parseProfitAndLoss, ProfitAndLossShapeError } = require('../index');

const SETTINGS = { clientId: 'client-id', clientSecret: 'client-secret', redirectUri: 'https://example.com/cb' };

const section = (group, label, value, extra) => ({
  type: 'Section', group, Summary: { ColData: [{ value: label }, { value }] }, ...(extra || {}),
});

/** A production-shaped report: nested income accounts, COGS, expenses, net income. */
function report({ income = '28,755.40', expenses = '10,000.00', net = '18,755.40' } = {}) {
  return {
    Header: { ReportName: 'ProfitAndLoss', StartPeriod: '2026-09-01', EndPeriod: '2026-09-06', ReportBasis: 'Accrual', Currency: 'USD' },
    Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, { ColTitle: 'Total', ColType: 'Money' }] },
    Rows: { Row: [
      {
        type: 'Section', group: 'Income', Header: { ColData: [{ value: 'Income' }, { value: '' }] },
        Rows: { Row: [
          { type: 'Data', ColData: [{ value: 'Maintenance Services', id: '12' }, { value: '20,940.00' }] },
          section(undefined, 'Total Repairs', '7,815.40', { Header: { ColData: [{ value: 'Repairs' }, { value: '' }] } }),
        ] },
        Summary: { ColData: [{ value: 'Total Income' }, { value: income }] },
      },
      section('COGS', 'Total Cost of Goods Sold', '0.00'),
      section('GrossProfit', 'Gross Profit', income),
      section('Expenses', 'Total Expenses', expenses),
      section('NetOperatingIncome', 'Net Operating Income', net),
      section('NetIncome', 'Net Income', net),
    ] },
  };
}

test('Total Income comes from the Income section by group, with the header and the other figures beside it', () => {
  const p = parseProfitAndLoss(report());
  assert.equal(p.totalIncome, 28755.40);
  assert.equal(p.totalExpenses, 10000);
  assert.equal(p.netIncome, 18755.40);
  assert.deepEqual(p.header, { start: '2026-09-01', end: '2026-09-06', basis: 'Accrual', currency: 'USD' });
});

test('a nested "Total Repairs" subtotal is never mistaken for Total Income; rows are found by group, not position', () => {
  const r = report();
  // Shuffle: Income last, NetIncome first.
  r.Rows.Row.reverse();
  assert.equal(parseProfitAndLoss(r).totalIncome, 28755.40);
  // No group on the Income section: the label still finds it.
  const byLabel = report();
  delete byLabel.Rows.Row[byLabel.Rows.Row.length - 1].group;
  byLabel.Rows.Row.reverse();
  delete byLabel.Rows.Row[byLabel.Rows.Row.length - 1].group;
  assert.equal(parseProfitAndLoss(byLabel).totalIncome, 28755.40);
});

test('an empty period reads as zero income; a report with no Income section is refused, never zero', () => {
  const empty = report({ income: '' });
  assert.equal(parseProfitAndLoss(empty).totalIncome, 0);
  const noExpenses = report();
  noExpenses.Rows.Row = noExpenses.Rows.Row.filter((s) => s.group !== 'Expenses');
  assert.equal(parseProfitAndLoss(noExpenses).totalExpenses, null);

  const noIncome = report();
  noIncome.Rows.Row = noIncome.Rows.Row.filter((s) => s.group !== 'Income');
  assert.throws(() => parseProfitAndLoss(noIncome), (e) => e instanceof ProfitAndLossShapeError && /Income section/.test(e.message));
  assert.throws(() => parseProfitAndLoss({ Header: {}, Rows: { Row: [] } }), ProfitAndLossShapeError);
  assert.throws(() => parseProfitAndLoss(null), ProfitAndLossShapeError);
});

test('a report summarised by month carries the Total as the last amount cell, and negatives and commas read right', () => {
  const r = report();
  r.Rows.Row[0].Summary.ColData = [{ value: 'Total Income' }, { value: '10,000.00' }, { value: '-1,244.60' }, { value: '8,755.40' }];
  assert.equal(parseProfitAndLoss(r).totalIncome, 8755.40);
  const neg = report({ income: '-12.5' });
  assert.equal(parseProfitAndLoss(neg).totalIncome, -12.5);
});

/* ------------------------------------------------------------ the read -- */

function memoryCredentials(seed) {
  const rows = { ...seed };
  return { get: (t, p) => rows[t + '/' + p] ?? null, save() {}, remove() {} };
}
const live = () => ({
  realm_id: 'REALM-1', access_token: 'access-live', refresh_token: 'refresh-live',
  access_expires_at: Date.now() + 3600e3, refresh_expires_at: Date.now() + 100 * 86400e3,
});

function rig(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: (init.method || 'GET').toUpperCase(), init });
    return handler(String(url));
  };
  const money = createFinancial({ credentials: memoryCredentials({ 'sandbox/quickbooks': live() }), fetchImpl, quickbooks: SETTINGS });
  return { money, calls };
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('getIncome asks for exactly the window and basis, as a GET, and hands back the figure with its window', async () => {
  const { money, calls } = rig((url) => (url.includes('/reports/ProfitAndLoss') ? ok(report()) : { ok: false, status: 404, text: async () => '{}' }));
  const out = await money.getIncome({ tenant: 'sandbox', start: '2026-08-29', end: new Date('2026-09-27T12:00:00Z'), basis: 'Cash' });
  assert.equal(out.totalIncome, 28755.40);
  assert.equal(out.start, '2026-08-29');
  assert.equal(out.end, '2026-09-27');
  assert.equal(out.basis, 'Cash');
  assert.equal(out.provider, 'quickbooks');
  const c = calls.find((x) => x.url.includes('/reports/ProfitAndLoss'));
  assert.equal(c.method, 'GET');
  assert.equal(c.init.body, undefined);
  const u = new URL(c.url);
  assert.equal(u.searchParams.get('start_date'), '2026-08-29');
  assert.equal(u.searchParams.get('end_date'), '2026-09-27');
  assert.equal(u.searchParams.get('accounting_method'), 'Cash');
});

test('getIncome refuses a missing or backwards window, and a report it cannot read, rather than answering zero', async () => {
  const { money, calls } = rig(() => ok({ Header: {}, Rows: { Row: [section('Expenses', 'Total Expenses', '1.00')] } }));
  await assert.rejects(() => money.getIncome({ tenant: 'sandbox', start: '2026-09-01' }), /needs \{ start, end \}/);
  await assert.rejects(() => money.getIncome({ tenant: 'sandbox', start: '2026-09-27', end: '2026-09-01' }), /is before start/);
  await assert.rejects(() => money.getIncome({ tenant: 'sandbox', start: 'Sept 1', end: '2026-09-27' }), /not a YYYY-MM-DD/);
  assert.equal(calls.length, 0, 'nothing was asked of Intuit for a refused window');
  await assert.rejects(() => money.getIncome({ tenant: 'sandbox', start: '2026-09-01', end: '2026-09-27' }), ProfitAndLossShapeError);
  await assert.rejects(() => money.getIncome({ start: '2026-09-01', end: '2026-09-27' }), /every read is per tenant/);
});
