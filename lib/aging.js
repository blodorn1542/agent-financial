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
 * PROVENANCE - do not re-solve the parsing.
 * parseAgingReport came verbatim from nickel-collections lib/aging-report.js at
 * commit 9eebc3c, where the openArTotal vs agingReportTotal mismatch was found
 * and fixed, and it has not been touched since. The fix is the Section handling
 * below: a parent customer's Summary is a SUBTOTAL, and reading it as the grand
 * total is what produced $562.50 against a real $5,281.52. The sub-customer
 * de-dup, the basis and the as-of date all come through the adapter unchanged.
 * If that looks like it needs re-investigating, read test/aging.test.js first -
 * it is the record of what was already wrong once.
 *
 * reconcile() HAS changed since the move: it now nets unapplied credit memos
 * and unapplied payments off the invoice side before comparing. That is a
 * different bug from the one above - see the comment on reconcile() and
 * test/netting.test.js. It changes what is compared, never how the report is
 * read.
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
 * What we owe-chasers think is outstanding vs the aging report, customer by
 * customer. Customers are matched on QuickBooks id; a report row with no id
 * falls back to an exact name match.
 *
 * Open invoices are not the whole of A/R. A customer holding an unapplied
 * credit memo, or money paid on account that has not been applied to an
 * invoice yet, owes less than their invoices say - and QuickBooks' aging
 * report already knows that, because it reports the A/R balance rather than a
 * sum of invoices. Comparing a gross invoice sum against a netted report is
 * comparing two different questions, and on real books it produces a diff that
 * never closes no matter how correct both sides are.
 *
 * So the invoice side is netted the same way `evaluate()` nets it before
 * flagging anyone: minus open credit memos, minus unapplied payments. Applied
 * payments are NOT netted - they already reduced the live invoice balances, and
 * subtracting them again would count them twice.
 *
 * `invoiceTotal` stays the gross number, and `creditTotal` /
 * `unappliedPaymentTotal` / `netTotal` are reported beside it, so a diff can be
 * attributed instead of guessed at.
 */
function reconcile({ invoices = [], creditMemos = [], payments = [], report, asOf = new Date() }) {
  const parsed = parseAgingReport(report);

  const ours = new Map();
  const bucketFor = (ref) => {
    const id = String(ref?.value ?? '');
    if (!id) return null;
    if (!ours.has(id)) {
      ours.set(id, {
        customerId: id, customerName: ref?.name || null,
        invoiceTotal: 0, credits: 0, unappliedPayments: 0, invoices: [],
      });
    }
    const a = ours.get(id);
    if (!a.customerName && ref?.name) a.customerName = ref.name;
    return a;
  };

  for (const inv of invoices) {
    const a = bucketFor(inv.CustomerRef);
    if (!a) continue;
    const balance = round(inv.Balance);
    a.invoiceTotal = round(a.invoiceTotal + balance);
    a.invoices.push({
      id: String(inv.Id), number: inv.DocNumber || String(inv.Id),
      txnDate: inv.TxnDate || null, dueDate: inv.DueDate || null, balance,
    });
  }

  // An open credit memo's Balance is the part not yet applied to an invoice.
  // A customer can hold one without having a single open invoice, which is
  // exactly the case that used to vanish from this comparison entirely.
  for (const cm of creditMemos) {
    const a = bucketFor(cm.CustomerRef);
    if (!a) continue;
    a.credits = round(a.credits + round(cm.Balance));
  }

  // Money received and sitting on account. UnappliedAmt only - see above.
  for (const p of payments) {
    const a = bucketFor(p.CustomerRef);
    if (!a) continue;
    a.unappliedPayments = round(a.unappliedPayments + round(p.UnappliedAmt));
  }

  for (const a of ours.values()) {
    a.netTotal = round(a.invoiceTotal - a.credits - a.unappliedPayments);
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

  const sum = (key) => round([...ours.values()].reduce((t, a) => t + a[key], 0));
  const invoiceTotal = sum('invoiceTotal');
  const creditTotal = sum('credits');
  const unappliedPaymentTotal = sum('unappliedPayments');
  const netTotal = round(invoiceTotal - creditTotal - unappliedPaymentTotal);
  const reportTotal = parsed.grandTotal;
  return {
    asOf: asOf instanceof Date ? asOf.toISOString() : asOf,
    header: parsed.header,
    columns: parsed.columns,
    invoiceTotal,
    creditTotal,
    unappliedPaymentTotal,
    netTotal,
    reportTotal,
    // The netted number is the one that is comparable with the report.
    diff: round(netTotal - (reportTotal ?? 0)),
    customersInInvoices: ours.size,
    customersInReport: parsed.customers.length,
    matched: rows.filter((r) => r.diff === 0).length,
    mismatched: rows.filter((r) => r.diff !== 0).length,
    rows,
  };
}

function row(a, r) {
  const invoiceTotal = a?.invoiceTotal ?? 0;
  const credits = a?.credits ?? 0;
  const unappliedPayments = a?.unappliedPayments ?? 0;
  const netTotal = round(invoiceTotal - credits - unappliedPayments);
  const reportTotal = r?.total ?? 0;
  return {
    customerId: a?.customerId ?? r?.customerId ?? null,
    customerName: a?.customerName || r?.customerName || null,
    invoiceTotal,
    credits,
    unappliedPayments,
    netTotal,
    reportTotal,
    diff: round(netTotal - reportTotal),
    inInvoices: !!a,
    inReport: !!r,
    invoices: a?.invoices ?? [],
    reportBuckets: r?.buckets ?? null,
  };
}

module.exports = { parseAgingReport, agingReportTotal, reconcile, round };
