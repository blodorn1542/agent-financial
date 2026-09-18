'use strict';

/**
 * Reads Intuit's AgedReceivables report JSON into something we can hold up
 * against our own invoice math. Pure and read-only: report in, numbers out.
 *
 * Milestone 1 of the spec is "pull A/R and confirm the numbers match what
 * QuickBooks shows on screen". The aging report *is* what QuickBooks shows on
 * screen, so a per-customer diff between it and the open-invoice sum is the
 * reconciliation, not just a total-to-total glance.
 *
 * PROVENANCE - do not re-solve this.
 * Moved verbatim from nickel-collections lib/aging-report.js at commit 9eebc3c,
 * where the openArTotal vs agingReportTotal mismatch was found and fixed. The
 * fix is the Section handling below: a parent customer's Summary is a SUBTOTAL,
 * and reading it as the grand total is what produced $562.50 against a real
 * $5,281.52. The sub-customer de-dup, the basis and the as-of date all come
 * through the adapter unchanged. If this file looks like it needs
 * re-investigating, read test/aging.test.js first - it is the record of what
 * was already wrong once.
 */

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function num(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function columnTitles(report) {
  return (report?.Columns?.Column || []).map((c) => c.ColTitle ?? '');
}

/**
 * @returns {{ header, columns, customers: Array<{customerId, customerName, buckets, total}>, grandTotal }}
 */
function parseAgingReport(report) {
  const columns = columnTitles(report);
  const totalIdx = Math.max(columns.length - 1, 1);
  const customers = [];
  let grandTotal = null;

  const pushCustomer = (cd) => {
    const buckets = {};
    for (let i = 1; i < totalIdx; i++) buckets[columns[i] || String(i)] = round(num(cd[i]?.value));
    customers.push({
      customerId: cd[0]?.id != null ? String(cd[0].id) : null,
      customerName: cd[0]?.value ?? '',
      buckets,
      total: round(num(cd[totalIdx]?.value)),
    });
  };

  // Intuit's shape: a plain customer is { ColData } (top-level rows carry no
  // `type`; nested ones say "Data"). A parent customer with sub-customers is a
  // Section: its own balance sits in Header.ColData, the children in Rows, and
  // Summary is the *subtotal* - never mistake that for the grand total.
  const walk = (rows) => {
    for (const r of rows || []) {
      const isSection = r.type === 'Section' || r.Rows || r.Header || r.Summary;
      if (!isSection && Array.isArray(r.ColData)) {
        pushCustomer(r.ColData);
        continue;
      }
      if (r.group === 'GrandTotal' && r.Summary?.ColData) {
        grandTotal = round(num(r.Summary.ColData[totalIdx]?.value));
        continue;
      }
      const head = r.Header?.ColData;
      if (Array.isArray(head) && head[0]?.id != null && num(head[totalIdx]?.value) !== 0) {
        pushCustomer(head); // the parent's own invoices, when it has any
      }
      walk(r.Rows?.Row);
    }
  };
  walk(report?.Rows?.Row);

  if (grandTotal === null && customers.length) {
    grandTotal = round(customers.reduce((s, c) => s + c.total, 0));
  }
  return { header: report?.Header || null, columns, customers, grandTotal };
}

/** Grand total only - what the daily run logs as its sanity cross-check. */
function agingReportTotal(report) {
  try {
    return parseAgingReport(report).grandTotal;
  } catch {
    return null;
  }
}

/**
 * Open invoices vs the aging report, customer by customer.
 * Customers are matched on QuickBooks id; a report row with no id falls back
 * to an exact name match.
 */
function reconcile({ invoices = [], report, asOf = new Date() }) {
  const parsed = parseAgingReport(report);

  const ours = new Map();
  for (const inv of invoices) {
    const id = String(inv.CustomerRef?.value ?? '');
    if (!id) continue;
    const balance = round(inv.Balance);
    if (!ours.has(id)) {
      ours.set(id, { customerId: id, customerName: inv.CustomerRef?.name || null, invoiceTotal: 0, invoices: [] });
    }
    const a = ours.get(id);
    a.invoiceTotal = round(a.invoiceTotal + balance);
    a.invoices.push({
      id: String(inv.Id), number: inv.DocNumber || String(inv.Id),
      txnDate: inv.TxnDate || null, dueDate: inv.DueDate || null, balance,
    });
  }

  const theirs = new Map();
  const theirsByName = new Map();
  for (const c of parsed.customers) {
    if (c.customerId) theirs.set(c.customerId, c);
    else theirsByName.set(c.customerName.trim().toLowerCase(), c);
  }

  const rows = [];
  const seenReport = new Set();
  for (const a of ours.values()) {
    let r = theirs.get(a.customerId);
    if (!r && a.customerName) r = theirsByName.get(a.customerName.trim().toLowerCase());
    if (r) seenReport.add(r);
    rows.push(row(a, r));
  }
  for (const r of parsed.customers) {
    if (!seenReport.has(r)) rows.push(row(null, r));
  }

  rows.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff) ||
    String(x.customerName).localeCompare(String(y.customerName)));

  const invoiceTotal = round([...ours.values()].reduce((s, a) => s + a.invoiceTotal, 0));
  const reportTotal = parsed.grandTotal;
  return {
    asOf: asOf instanceof Date ? asOf.toISOString() : asOf,
    header: parsed.header,
    columns: parsed.columns,
    invoiceTotal,
    reportTotal,
    diff: round(invoiceTotal - (reportTotal ?? 0)),
    customersInInvoices: ours.size,
    customersInReport: parsed.customers.length,
    matched: rows.filter((r) => r.diff === 0).length,
    mismatched: rows.filter((r) => r.diff !== 0).length,
    rows,
  };
}

function row(a, r) {
  const invoiceTotal = a?.invoiceTotal ?? 0;
  const reportTotal = r?.total ?? 0;
  return {
    customerId: a?.customerId ?? r?.customerId ?? null,
    customerName: a?.customerName || r?.customerName || null,
    invoiceTotal,
    reportTotal,
    diff: round(invoiceTotal - reportTotal),
    inInvoices: !!a,
    inReport: !!r,
    invoices: a?.invoices ?? [],
    reportBuckets: r?.buckets ?? null,
  };
}

module.exports = { parseAgingReport, agingReportTotal, reconcile, round };
