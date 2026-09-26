'use strict';

/**
 * Reads Intuit's AgedReceivableDetail report JSON into one row per open A/R
 * transaction. Pure and read-only: report in, rows out.
 *
 * Why this exists beside parseAgingReport (lib/aging.js, which this file does
 * not touch): the summary report says WHAT a customer's A/R balance is; only
 * the detail report says what it is MADE OF. On the live books on 2026-09-26
 * the gap between gross open invoices and the aging total was $29,694.02, and
 * all of it was A/R the invoice list cannot see:
 *
 *   - 57 unapplied payments, dated 2011-2026 (-$28,937.51). There is no
 *     "all unapplied payments" query, only a date window, so the older money
 *     on account was invisible to every caller that read payments by date.
 *   - journal entries against customers: five credits and one charge
 *     (-$756.51 net). Nothing read journal entries at all.
 *
 * The detail report lists every one of those, whatever its type, with its own
 * open balance. A negative open balance is a credit the customer holds.
 *
 * THE SHAPE, and what is and is not documented (Intuit's ARAgingDetail
 * reference, read 2026-09-26):
 *
 *   documented  Rows.Row nests: `type: "Section"` encloses sub-rows (here, an
 *               aging bucket, Header "31 - 60 days past due"), `type: "Data"`
 *               is a leaf. A Section may carry Header, Rows and Summary, and
 *               the sample also shows a Header-only "Total for ..." Section.
 *               Leaf ColData cells carry `value`, plus `id` "where applicable"
 *               - the customer cell carries the Customer.Id. Columns carry
 *               ColType and ColTitle, and ColTitle is LOCALIZED (the sample's
 *               customer column is titled "Client", not "Customer"). The
 *               `columns` query parameter lists cust_name, doc_num, due_date,
 *               tx_date, txn_type ... and no key for Amount or Open Balance.
 *   not         What ColType the default columns carry. The sample shows keys
 *   documented  ("cust_name", "due_date"); the attribute reference says
 *               "Account" / "Money". Other Intuit reports put the key in
 *               MetaData ColKey. The key for Open Balance is not documented
 *               anywhere. Nor is it documented that the transaction-type cell
 *               carries the transaction's id.
 *
 * So a column is found by any of: its ColType, its MetaData ColKey, or its
 * title - never by position. A report without a Customer or Open Balance
 * column is refused with AgingDetailColumnError rather than read as zero: a
 * missing credit here would chase someone who does not owe.
 *
 * Summary rows and Section headers are subtotals and bucket labels. They are
 * never read as transactions - the same mistake that produced $562.50 in the
 * summary report (see lib/aging.js) would, here, count every credit twice.
 */

class AgingDetailColumnError extends Error {
  constructor(missing, titles) {
    super('AgedReceivableDetail report has no ' + missing.join(' or ') + ' column (columns: ' +
      (titles.length ? titles.map((t) => '"' + t + '"').join(', ') : 'none') +
      '). Refusing to read it: a credit that cannot be seen is a customer chased for money they do not owe.');
    this.name = 'AgingDetailColumnError';
    this.missing = missing;
    this.columns = titles;
  }
}

function round(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function num(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Where each field lives. `keys` are matched against ColType and MetaData
 * ColKey, `title` against ColTitle. The Amount and Open Balance keys are a
 * guess (see above), which is why their titles are matched too.
 */
const FIELDS = {
  date: { keys: /^tx_date$/i, title: /^(date|transaction date)$/i },
  txnType: { keys: /^txn_type$/i, title: /^(transaction type|type)$/i },
  docNumber: { keys: /^doc_num$/i, title: /^(num|no\.?|number)$/i },
  customer: { keys: /^cust_name$/i, title: /^(customer|client|customer name|name)$/i },
  dueDate: { keys: /^due_date$/i, title: /^due date$/i },
  amount: { keys: /^(subt_)?(nat_)?amount$|^subt_amt$/i, title: /^amount$/i },
  openBalance: { keys: /open_?bal/i, title: /^open balance$/i },
};

const REQUIRED = { customer: 'Customer', openBalance: 'Open Balance' };

function columnKeys(col) {
  const keys = [col?.ColType];
  for (const m of col?.MetaData || []) {
    if (/^ColKey$/i.test(m?.Name ?? '')) keys.push(m.Value);
  }
  return keys.filter((k) => typeof k === 'string' && k);
}

/** Field name -> column index, by key first and title second. */
function locateColumns(report) {
  const cols = report?.Columns?.Column || [];
  const at = {};
  for (const [field, m] of Object.entries(FIELDS)) {
    let i = cols.findIndex((c) => columnKeys(c).some((k) => m.keys.test(k)));
    if (i < 0) i = cols.findIndex((c) => m.title.test(String(c?.ColTitle ?? '').trim()));
    at[field] = i < 0 ? null : i;
  }
  const missing = Object.keys(REQUIRED).filter((f) => at[f] === null).map((f) => REQUIRED[f]);
  if (missing.length) throw new AgingDetailColumnError(missing, cols.map((c) => c?.ColTitle ?? ''));
  return at;
}

/** YYYY-MM-DD, whether Intuit sent it that way or as a localized m/d/yyyy. */
function isoDay(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) return us[3] + '-' + us[1].padStart(2, '0') + '-' + us[2].padStart(2, '0');
  return s;
}

/**
 * @returns {{ header, columns, rows: Array<{customerId, customerName, txnType, txnId,
 *            docNumber, date, dueDate, amount, openBalance, section}>, total }}
 * @throws {AgingDetailColumnError} when the Customer or Open Balance column is missing
 */
function parseAgingDetailReport(report) {
  const at = locateColumns(report);
  const cell = (cd, field) => (at[field] === null ? undefined : cd[at[field]]);
  const text = (cd, field) => {
    const v = cell(cd, field)?.value;
    return v === undefined || v === null || v === '' ? null : String(v);
  };
  const rows = [];

  const pushRow = (cd, section) => {
    const cust = cell(cd, 'customer');
    const customerName = text(cd, 'customer');
    const openBalance = round(num(cell(cd, 'openBalance')?.value));
    // A leaf with no customer and nothing open is padding, not a transaction.
    if (!customerName && cust?.id == null && openBalance === 0) return;
    const type = cell(cd, 'txnType');
    const doc = cell(cd, 'docNumber');
    rows.push({
      customerId: cust?.id != null && cust.id !== '' ? String(cust.id) : null,
      customerName,
      txnType: text(cd, 'txnType'),
      // Undocumented: the type cell's id is the transaction's own id. Falls
      // back to the number cell's id, then null - never invented.
      txnId: type?.id != null && type.id !== '' ? String(type.id)
        : doc?.id != null && doc.id !== '' ? String(doc.id) : null,
      docNumber: text(cd, 'docNumber'),
      date: isoDay(text(cd, 'date')),
      dueDate: isoDay(text(cd, 'dueDate')),
      amount: at.amount === null ? null : round(num(cell(cd, 'amount')?.value)),
      openBalance,
      section,
    });
  };

  // Sections are aging buckets. Their Header is a label and their Summary a
  // subtotal; only leaf rows are transactions.
  const walk = (list, section) => {
    for (const r of list || []) {
      const isSection = r.type === 'Section' || r.Rows || r.Header || r.Summary;
      if (!isSection && Array.isArray(r.ColData)) {
        pushRow(r.ColData, section);
        continue;
      }
      const label = r.Header?.ColData?.[0]?.value || section;
      walk(r.Rows?.Row, label || null);
    }
  };
  walk(report?.Rows?.Row, null);

  return {
    header: report?.Header || null,
    columns: (report?.Columns?.Column || []).map((c) => c?.ColTitle ?? ''),
    rows,
    total: round(rows.reduce((s, r) => s + r.openBalance, 0)),
  };
}

/** Invoices are what the open-invoice list already holds; everything else is not. */
function isInvoice(row) {
  return /^invoice$/i.test(String(row.txnType ?? '').trim());
}

/**
 * The rows split the way a collector needs them:
 *
 *   credits   every negative open balance - unapplied payments, credit memos,
 *             journal-entry credits, refunds, whatever the report lists -
 *             with `openBalance` turned into a POSITIVE amount held.
 *   charges   positive open balances that are not invoices (a journal-entry
 *             charge, say). They are part of A/R, so a reconciliation needs
 *             them; whether to chase them is the caller's business.
 *   invoices  positive invoice rows, counted only, for the caller's own check.
 */
function splitOpenCredits(rows) {
  const credits = [];
  const charges = [];
  let invoiceTotal = 0;
  let invoiceCount = 0;
  for (const r of rows) {
    if (r.openBalance < 0) {
      credits.push({ ...r, openBalance: round(-r.openBalance) });
    } else if (r.openBalance > 0) {
      if (isInvoice(r)) {
        invoiceTotal = round(invoiceTotal + r.openBalance);
        invoiceCount++;
      } else {
        charges.push(r);
      }
    }
  }
  const sum = (list) => round(list.reduce((s, r) => s + r.openBalance, 0));
  return {
    credits, charges,
    totals: {
      credits: sum(credits), creditCount: credits.length,
      charges: sum(charges), chargeCount: charges.length,
      invoices: invoiceTotal, invoiceCount,
    },
  };
}

module.exports = { parseAgingDetailReport, splitOpenCredits, locateColumns, AgingDetailColumnError };
