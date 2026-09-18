'use strict';

/**
 * The reconciliation was already solved once, in nickel-collections, against
 * live sandbox books. These tests exist so the move into this package cannot
 * quietly un-solve it.
 *
 * The first four are Nickel's own aging-report tests, carried over unchanged.
 * The last two are new: the same real report that produced the original
 * $562.50, held against the real invoice list, so the regression is guarded by
 * evidence and not only by a hand-built shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAgingReport, agingReportTotal, reconcile } = require('../lib/aging');

/** The shape Intuit returns for /reports/AgedReceivables. */
function report() {
  return {
    Header: { ReportName: 'AgedReceivables', ReportBasis: 'Accrual', StartPeriod: '2026-09-17', EndPeriod: '2026-09-17' },
    Columns: { Column: [
      { ColTitle: '', ColType: 'Customer' }, { ColTitle: 'Current' }, { ColTitle: '1 - 30' },
      { ColTitle: '31 - 60' }, { ColTitle: '61 - 90' }, { ColTitle: '91 and over' }, { ColTitle: 'Total' },
    ] },
    Rows: { Row: [
      // Top-level customers carry no `type` in Intuit's JSON.
      { ColData: [{ value: 'Amy Bird Sanctuary', id: '1' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '239.00' }, { value: '239.00' }] },
      // A parent with sub-customers: own balance in Header, children in Rows,
      // and a Summary that is a SUBTOTAL - the bug that produced $562.50.
      { Header: { ColData: [{ value: 'Freeman Sporting Goods', id: '7' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '0.00' }] },
        Rows: { Row: [
          { ColData: [{ value: 'Red Rock Diner', id: '20' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '226.00' }, { value: '226.00' }], type: 'Data' },
        ] },
        Summary: { ColData: [{ value: 'Total Freeman Sporting Goods' }, { value: '0.00' }, { value: '0.00' }, { value: '0.00' }, { value: '0.00' }, { value: '226.00' }, { value: '226.00' }] },
        type: 'Section' },
      { ColData: [{ value: 'Only in report', id: '99' }, { value: '97.50' }, { value: '' }, { value: '' }, { value: '' }, { value: '' }, { value: '97.50' }] },
      { Summary: { ColData: [{ value: 'TOTAL' }, { value: '97.50' }, { value: '' }, { value: '' }, { value: '' }, { value: '465.00' }, { value: '562.50' }] }, type: 'Section', group: 'GrandTotal' },
    ] },
  };
}

test('parses customers, buckets and the grand total', () => {
  const p = parseAgingReport(report());
  assert.equal(p.grandTotal, 562.5);
  const names = p.customers.map((c) => c.customerName);
  // The parent has no invoices of its own (0.00), so it is not a customer row.
  assert.deepEqual(names, ['Amy Bird Sanctuary', 'Red Rock Diner', 'Only in report']);
  assert.equal(p.customers[0].customerId, '1');
  assert.equal(p.customers[0].buckets['91 and over'], 239);
  assert.equal(agingReportTotal(report()), 562.5);
});

test('a sub-customer subtotal is never mistaken for the grand total', () => {
  const r = report();
  r.Rows.Row.pop(); // drop the GrandTotal row entirely
  // Falls back to summing the customer rows, not the first Summary it sees.
  assert.equal(parseAgingReport(r).grandTotal, 562.5);
});

test('reconcile pairs invoices with report rows and names every gap', () => {
  const invoices = [
    { Id: '1', DocNumber: '1021', CustomerRef: { value: '1', name: 'Amy Bird Sanctuary' }, Balance: 239 },
    { Id: '2', DocNumber: '1023', CustomerRef: { value: '20', name: 'Red Rock Diner' }, Balance: 70 },
    { Id: '3', DocNumber: '1024', CustomerRef: { value: '20', name: 'Red Rock Diner' }, Balance: 156 },
    { Id: '4', DocNumber: '1035', CustomerRef: { value: '5', name: 'Mark Cho' }, Balance: 314.28 },
  ];
  const out = reconcile({ invoices, report: report() });
  assert.equal(out.invoiceTotal, 779.28);
  assert.equal(out.reportTotal, 562.5);
  assert.equal(out.diff, 216.78);
  assert.equal(out.matched, 2);
  const byName = Object.fromEntries(out.rows.map((r) => [r.customerName, r]));
  assert.equal(byName['Mark Cho'].inReport, false);
  assert.equal(byName['Mark Cho'].diff, 314.28);
  assert.equal(byName['Only in report'].inInvoices, false);
  assert.equal(byName['Only in report'].diff, -97.5);
  assert.equal(out.rows[0].customerName, 'Mark Cho'); // biggest gap first
});

test('tolerates an empty or malformed report', () => {
  assert.equal(agingReportTotal(null), null);
  const out = reconcile({ invoices: [], report: {} });
  assert.equal(out.reportTotal, null);
  assert.equal(out.rows.length, 0);
});

/* ------------------------------------------- the real books, as captured -- */

const sandbox = require('./fixtures/sandbox-aging.json');

test('the live sandbox books still reconcile to the cent after the move', () => {
  const out = reconcile({
    invoices: sandbox.invoices,
    report: sandbox.report,
    asOf: new Date(sandbox.asOf),
  });
  assert.deepEqual({
    invoiceTotal: out.invoiceTotal, reportTotal: out.reportTotal, diff: out.diff,
    customersInInvoices: out.customersInInvoices, customersInReport: out.customersInReport,
    matched: out.matched, mismatched: out.mismatched,
  }, sandbox.expected);
});

test('the $562.50 answer is a subtotal, and is not what the report totals', () => {
  // Freeman Sporting Goods is the section that caused it: two sub-customers,
  // a parent with nothing of its own, and a Summary that sums only that branch.
  const rows = sandbox.report.Rows.Row;
  const freeman = rows.find((r) => /Freeman/i.test(r.Header?.ColData?.[0]?.value || ''));
  assert.ok(freeman, 'the sandbox fixture must still contain the parent/sub-customer section');

  const totalIdx = sandbox.report.Columns.Column.length - 1;
  const subtotal = Number(freeman.Summary.ColData[totalIdx].value);
  assert.equal(subtotal, 562.5);

  // The parent itself owes nothing, so it must not appear as a customer row -
  // counting it would double the children underneath it.
  assert.equal(Number(freeman.Header.ColData[totalIdx].value), 0);
  const parsed = parseAgingReport(sandbox.report);
  assert.equal(parsed.customers.some((c) => /^Freeman/i.test(c.customerName)), false);

  // And the number an agent actually gets is the whole company, not the branch.
  assert.equal(parsed.grandTotal, 5281.52);
  assert.notEqual(parsed.grandTotal, subtotal);
});
