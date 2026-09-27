'use strict';

/**
 * The common interface agents call. Read-only, and read-only structurally
 * rather than by convention:
 *
 *   - METHODS below is the whole surface. It is an allow-list of reads, and
 *     the object handed back is frozen, so nothing can bolt a write on later.
 *   - assertReadOnly() refuses, at construction, any adapter that offers a
 *     `writes` object or names a read after a mutating verb.
 *   - The QuickBooks adapter's only path to the company file takes no HTTP
 *     method argument, so it cannot issue anything but a GET.
 *
 * That triple is deliberate. Nickel's "never touch the books" rule was one
 * agent's discipline; putting it here makes it every agent's, including the
 * ones that have not been written yet.
 */

const { parseAgingReport, reconcile, round } = require('./aging');
const { parseAgingDetailReport, splitOpenCredits } = require('./aging-detail');
const { parseProfitAndLoss } = require('./profit-and-loss');

/** Every method an agent may call. Adding a write here is the thing not to do. */
const METHODS = [
  'getArAging',
  'getOpenInvoices',
  'getPaymentsSince',
  'getCustomers',
  // Beyond the four named in the spec, because real collections logic needs
  // them and the alternative is each agent reaching past the interface.
  'getOpenCreditMemos',
  'getInvoicesSince',
  'getCompanyInfo',
  // Every credit a customer holds, of any type and any age - the money on
  // account that no payments window can be trusted to find.
  'getOpenCredits',
  // Income for a date window from the P&L: a host's "sales this month /
  // this year" figure, on the books' terms rather than a sum of invoices.
  'getIncome',
];

/** Any read whose name starts like this is not a read. */
const MUTATING = /^(create|update|delete|remove|write|post|put|patch|void|send|save|set|sync|apply|add)/i;

/**
 * Intuit's column titles vary in spacing and wording between report versions,
 * so agents get stable keys and the original title is kept alongside.
 */
const BUCKETS = [
  { key: 'current', match: /^current$/i },
  { key: 'd1_30', match: /^1\s*-\s*30$/ },
  { key: 'd31_60', match: /^31\s*-\s*60$/ },
  { key: 'd61_90', match: /^61\s*-\s*90$/ },
  { key: 'd91_plus', match: /^91\s*(and over|\+|or more)$/i },
];

function bucketKey(title) {
  return BUCKETS.find((b) => b.match.test(String(title).trim()))?.key ?? null;
}

/** Report bucket titles -> canonical keys, keeping anything unrecognized visible. */
function normalizeBuckets(buckets) {
  const out = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d91_plus: 0 };
  const unmapped = {};
  for (const [title, value] of Object.entries(buckets || {})) {
    const key = bucketKey(title);
    if (key) out[key] = round(out[key] + value);
    else if (value) unmapped[title] = value;
  }
  if (Object.keys(unmapped).length) out.unmapped = unmapped;
  return out;
}

function assertReadOnly(adapter) {
  const name = adapter?.name ?? 'unknown';
  if (adapter?.writes) {
    throw new Error('Adapter "' + name + '" exposes a writes object. This package is ' +
      'read-only by construction: agents read the books, they never touch them.');
  }
  for (const key of Object.keys(adapter?.reads || {})) {
    if (MUTATING.test(key)) {
      throw new Error('Adapter "' + name + '" declares "' + key + '" as a read, but that ' +
        'name reads like a write. Reads are named get*; nothing here may mutate the books.');
    }
  }
  return adapter;
}

function createInterface({ adapters, defaultProvider }) {
  const names = Object.keys(adapters);
  if (!names.length) throw new Error('No financial adapters were configured');

  /** Which books this tenant's money lives in. */
  function adapterFor(provider) {
    const wanted = provider || defaultProvider || names[0];
    const a = adapters[wanted];
    if (!a) {
      throw new Error('No financial adapter named "' + wanted + '". Available: ' + names.join(', '));
    }
    return a;
  }

  /**
   * Every read goes through here, and every read is async - including the
   * argument checks. A caller that handles failure with .catch() must not have
   * some methods throw past it because they happened to fail early.
   */
  async function read(args, fn) {
    const { tenant, provider } = args || {};
    if (!tenant) throw new Error('Pass { tenant } - every read is per tenant, never global');
    return fn(adapterFor(provider), tenant);
  }

  const api = {
    /**
     * Normalized A/R aging: per customer, per bucket, and reconciled against
     * the open invoices rather than merely reported.
     *
     * "Reconciled" is load-bearing. The report and the invoice list are two
     * different answers to the same question, and they disagreed once already
     * ($562.50 against $5,281.52 - see lib/aging.js). Every agent gets the
     * reconciliation for free, plus `reconciled: false` and a per-customer
     * breakdown on the day they disagree again.
     *
     * The invoice side is netted against unapplied credit memos before the
     * comparison, because the report is a netted A/R balance and a gross
     * invoice sum is not comparable with it. Unapplied payments net too, but
     * only when the caller supplies `payments` or a `paymentsSince` window -
     * see the note in the body for why they are not fetched by default.
     *
     * `includeRaw: true` attaches the provider's own report under `raw`, for
     * an admin view that needs to show its working.
     */
    async getArAging(args = {}) {
      const {
        asOf, basis = 'Accrual', agingMethod, includeRaw = false,
        payments: suppliedPayments, paymentsSince,
      } = args;
      return read(args, async (adapter, tenant) => {
        const opts = { basis };
        if (asOf) opts.asOf = typeof asOf === 'string' ? asOf : isoDate(asOf);
        if (agingMethod) opts.agingMethod = agingMethod;

        // Credit memos are fetched unconditionally: "Balance > 0" returns every
        // unapplied credit there is, so netting them is complete rather than a
        // sample, and an unnetted credit is a diff that never closes.
        const [invoices, creditMemos, report] = await Promise.all([
          adapter.reads.getOpenInvoices(tenant),
          adapter.reads.getOpenCreditMemos(tenant),
          adapter.reads.getAgingReport(tenant, opts),
        ]);

        // Payments are different: there is no "all unapplied payments" query,
        // only a date window, and a partial set is worse than none - it would
        // look handled while quietly missing older money on account. So the
        // caller either supplies them or names the window, and either way
        // `paymentsWindow` in the result says what was actually covered.
        let payments = suppliedPayments;
        if (!payments && paymentsSince) {
          payments = await adapter.reads.getPaymentsSince(
            tenant, typeof paymentsSince === 'string' ? paymentsSince : isoDate(paymentsSince));
        }

        const parsed = parseAgingReport(report);
        const check = reconcile({
          invoices, creditMemos, payments: payments || [], report,
          asOf: opts.asOf ? new Date(opts.asOf) : new Date(),
        });

        return {
          tenant,
          provider: adapter.provider,
          asOf: check.asOf,
          basis,
          header: parsed.header,
          columns: parsed.columns,
          customers: parsed.customers.map((c) => ({
            customerId: c.customerId,
            customerName: c.customerName,
            buckets: normalizeBuckets(c.buckets),
            bucketsByTitle: c.buckets,
            total: c.total,
          })),
          total: parsed.grandTotal,
          reconciled: check.diff === 0 && check.mismatched === 0,
          reconciliation: {
            invoiceTotal: check.invoiceTotal,
            creditTotal: check.creditTotal,
            unappliedPaymentTotal: check.unappliedPaymentTotal,
            netTotal: check.netTotal,
            reportTotal: check.reportTotal,
            diff: check.diff,
            // What the payment side of the netting actually covered, so a
            // remaining diff can be read rather than guessed at.
            paymentsWindow: suppliedPayments ? 'supplied by caller'
              : paymentsSince ? ('since ' + (typeof paymentsSince === 'string' ? paymentsSince : isoDate(paymentsSince)))
              : 'not netted - pass payments or paymentsSince',
            customersInInvoices: check.customersInInvoices,
            customersInReport: check.customersInReport,
            matched: check.matched,
            mismatched: check.mismatched,
            rows: check.rows,
          },
          // A reconciliation you cannot audit is just another number. An admin
          // asking for the source document gets it; nothing else does.
          raw: includeRaw ? { report } : undefined,
        };
      });
    },

    /**
     * Every open A/R credit the books hold, from the A/R Aging Detail report:
     * unapplied payments of any age, credit memos, journal-entry credits,
     * refunds - whatever the report lists with a negative open balance.
     *
     *   credits  negative open-balance rows, `openBalance` as a POSITIVE
     *            amount held, each with its `date` so a caller can tell a
     *            week-old payment from a 2011 one.
     *   charges  positive rows that are not invoices (a journal-entry
     *            charge). Part of A/R, so part of any reconciliation.
     *   totals   the sums and counts of both, and of the invoice rows.
     *
     * Deliberately no judgement about which credits count: how old is too old
     * to net is a collector's policy, not the books'. A report missing its
     * Customer or Open Balance column rejects (AgingDetailColumnError) rather
     * than answering "no credits".
     */
    async getOpenCredits(args = {}) {
      const { asOf, basis = 'Accrual' } = args;
      return read(args, async (adapter, tenant) => {
        const opts = { basis };
        if (asOf) opts.asOf = typeof asOf === 'string' ? asOf : isoDate(asOf);
        const report = await adapter.reads.getAgingDetailReport(tenant, opts);
        const parsed = parseAgingDetailReport(report);
        const { credits, charges, totals } = splitOpenCredits(parsed.rows);
        return {
          tenant,
          provider: adapter.provider,
          asOf: opts.asOf || parsed.header?.EndPeriod || isoDate(new Date()),
          basis,
          credits,
          charges,
          totals: { ...totals, report: parsed.total },
        };
      });
    },

    /**
     * Income for one date window, from the Profit and Loss report on the
     * basis asked for. Both dates are required and inclusive (YYYY-MM-DD or
     * Dates). `totalIncome` is the report's Total Income; a window with no
     * activity reads as 0. A report whose shape cannot be read rejects
     * (ProfitAndLossShapeError) rather than answering zero.
     */
    async getIncome(args = {}) {
      const { basis = 'Accrual' } = args;
      return read(args, async (adapter, tenant) => {
        if (!args.start || !args.end) throw new Error('getIncome needs { start, end } - YYYY-MM-DD strings or Dates');
        const start = requireDate(args.start, 'getIncome');
        const end = requireDate(args.end, 'getIncome');
        if (end < start) throw new Error('getIncome: end ' + end + ' is before start ' + start);
        const report = await adapter.reads.getProfitAndLossReport(tenant, { basis, start, end });
        const parsed = parseProfitAndLoss(report);
        return {
          tenant,
          provider: adapter.provider,
          start, end, basis,
          totalIncome: parsed.totalIncome,
          totalExpenses: parsed.totalExpenses,
          netIncome: parsed.netIncome,
          header: parsed.header,
        };
      });
    },

    async getOpenInvoices(args = {}) {
      return read(args, (a, t) => a.reads.getOpenInvoices(t));
    },

    async getOpenCreditMemos(args = {}) {
      return read(args, (a, t) => a.reads.getOpenCreditMemos(t));
    },

    async getPaymentsSince(args = {}) {
      const date = requireDate(args.date, 'getPaymentsSince');
      return read(args, (a, t) => a.reads.getPaymentsSince(t, date));
    },

    async getInvoicesSince(args = {}) {
      const date = requireDate(args.date, 'getInvoicesSince');
      return read(args, (a, t) => a.reads.getInvoicesSince(t, date));
    },

    async getCustomers(args = {}) {
      return read(args, (a, t) => a.reads.getCustomers(t));
    },

    async getCompanyInfo(args = {}) {
      return read(args, (a, t) => a.reads.getCompanyInfo(t));
    },

    adapterFor,
  };

  // The surface is exactly METHODS, and it is sealed shut.
  for (const m of METHODS) {
    if (typeof api[m] !== 'function') throw new Error('Interface is missing ' + m + '()');
  }
  return Object.freeze(api);
}

function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function requireDate(date, who) {
  if (!date) throw new Error(who + ' needs { date } - a YYYY-MM-DD string or a Date');
  const s = typeof date === 'string' ? date : isoDate(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(who + ': "' + s + '" is not a YYYY-MM-DD date');
  return s;
}

module.exports = {
  createInterface, assertReadOnly, normalizeBuckets, bucketKey,
  METHODS, MUTATING, BUCKETS,
};
