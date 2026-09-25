# agent-financial

The shared financial layer for the agent platform. One read-only interface
agents call; the books behind it are interchangeable adapters.

An agent says "what does tenant X's A/R look like". It never learns that the
answer came from QuickBooks. Adding Xero later is one new adapter in
`lib/adapters/` and **zero agent changes** — that indirection is the whole
point of this package. Without it, every agent gets rewritten for every
accounting system.

The dependency runs one way only. This package knows nothing about any agent
that uses it: no invoices-to-chase, no thresholds, no escalation tiers.

## Nothing here writes

There are **no write methods**, and that is structural rather than a policy
anyone has to remember:

| Guard | Where |
|---|---|
| `METHODS` is an allow-list of reads, and the returned interface is frozen | `lib/interface.js` |
| An adapter exposing a `writes` object is refused at construction | `assertReadOnly()` |
| An adapter naming a read after a mutating verb (`create*`, `post*`, `void*`, …) is refused | `assertReadOnly()` |
| The only path to the company file takes no HTTP method, so it cannot issue anything but a `GET` | `lib/adapters/quickbooks.js` |

A test drives a full sweep of every read and asserts that each request reaching
`/v3/company/...` was a `GET` with no body. The only writes in the package are
to Intuit's OAuth endpoints — tokens, not ledgers.

## The interface

```js
const { createFinancial } = require('agent-financial');

// Sharing the host's existing OAuth storage, so nobody re-authorizes.
const money = createFinancial({ credentials });

// Or fully self-contained.
const money = createFinancial({ dbPath: '/data/financial.db' });

const aging = await money.getArAging({ tenant: 'acme', basis: 'Accrual' });
```

| Method | Returns |
|---|---|
| `getArAging({ tenant, asOf, basis, agingMethod, payments, paymentsSince })` | Per customer, per bucket, **reconciled and netted** — see below |
| `getOpenInvoices({ tenant })` | Every invoice with a balance |
| `getPaymentsSince({ tenant, date })` | Payments on or after `date` |
| `getCustomers({ tenant })` | Active customers |
| `getOpenCreditMemos({ tenant })` | Unapplied credit memos |
| `getInvoicesSince({ tenant, date })` | Invoices raised on or after `date` |
| `getCompanyInfo({ tenant })` | The connected company |

The last three go beyond the four the spec named. They are here because real
receivables logic needs them, and the alternative — an agent reaching around
the interface to the adapter — would defeat the layer on day one.

Every method is `async`, takes a `{ tenant }` object, and rejects rather than
throwing, including on bad arguments. There is no global read: a call without a
tenant is refused, not defaulted.

### The aging is reconciled, not merely reported

The aging report and the open-invoice list are two different answers to the
same question, and they disagreed once already — **$562.50 against a real
$5,281.52**, because a parent customer's section `Summary` is a *subtotal* and
reading it as the grand total silently throws the rest of the company away.

`getArAging` returns both answers and the comparison:

```js
{
  total: 5281.52,          // what the report says
  customers: [ { customerId, customerName, buckets, bucketsByTitle, total } ],
  reconciled: true,        // false the day they stop agreeing
  reconciliation: {
    invoiceTotal,          // gross: what the invoices say
    creditTotal,           // unapplied credit memos
    unappliedPaymentTotal, // money on account, not yet applied
    netTotal,              // invoiceTotal - credits - unapplied payments
    reportTotal, diff, matched, mismatched,
    paymentsWindow,        // what the payment side actually covered
    rows,                  // per customer, biggest gap first
  },
}
```

### Open invoices are not the whole of A/R

A customer holding an unapplied credit memo, or money paid on account that has
not been applied to an invoice, owes less than their invoices say — and the
aging report already knows it, because it reports the **A/R balance**, not a sum
of invoices. Comparing a gross invoice sum against a netted report asks a
different question on each side, and on real books it produces a diff that never
closes however correct both sides are.

So the invoice side is netted before the comparison: minus open credit memos,
minus unapplied payments. Applied payments are **not** netted — they already
reduced the live invoice balances, and subtracting them again would count them
twice. `invoiceTotal` is still reported beside `netTotal`, because whoever is
chasing the money still needs to know what the invoices say.

Credit memos are fetched automatically: `Balance > 0` returns every unapplied
credit there is, so netting them is complete. **Payments are not**, because
there is no "all unapplied payments" query — only a date window, and a partial
set is worse than none, since it looks handled while quietly missing older money
on account. Pass `payments` yourself, or a `paymentsSince` window, and
`paymentsWindow` in the result says what was covered either way.

Every agent inherits that check instead of each one rediscovering it. Buckets
come back on stable keys — `current`, `d1_30`, `d31_60`, `d61_90`, `d91_plus` —
with Intuit's original titles kept alongside in `bucketsByTitle`, because the
titles drift between report versions and the keys should not.

`lib/aging.js` carries the **report-parsing** fix from where it was originally
solved, untouched: the Section walk that distinguishes a parent's subtotal from
the grand total is the same code, and `test/aging.test.js` replays the real
report that produced the $562.50. **Do not re-investigate that** — read the
tests first. The netting above was added around it afterwards and is a separate
concern; it changes what is compared, never how the report is read.

## Adapters

| Adapter | Direction | Notes |
|---|---|---|
| `quickbooks` | read-only | Per-tenant OAuth. Sandbox by default; set `env: 'production'` or `QBO_ENV`. |

Planned, on demand rather than now: **Xero** (same interface, different books)
and **bank feeds** — which are a genuinely different data shape and will get
their own method rather than being forced into the aging interface.

## Credentials

`lib/credentials.js` is a port with a working default:

```
get(tenantId, provider)           -> the stored row, or null
save(tenantId, provider, tokens)
remove(tenantId, provider)
```

Reads come back in snake_case (`access_token`, `refresh_token`,
`access_expires_at`, `refresh_expires_at`, `realm_id`) because that is what a
SQLite row looks like — a SQL-backed host implements the port by handing over
its existing row-returning function rather than remapping every field. A host
whose table calls the company file `external_id` instead of `realm_id` works
unchanged; the adapter reads either.

**This is the point of the port.** A host that had a company authorized before
this package existed keeps that authorization: the adapter reads the row that
is already there. Moving code into a package must not cost anyone a re-auth.

**A leased row** carries `leased: true`, an `access_token`, its
`access_expires_at` and the `realm_id`, and no refresh token. It is what a
host gets from the platform gateway's credential vault, which keeps the
refresh token to itself. The adapter uses the access token as given and never
refreshes it: once it is within 30 seconds of expiry, every read refuses with
"start a new run". Nothing is ever saved for a leased row.

Omit the port and the package keeps its own `financial_connections` table,
which is namespaced so it can share a database file with a host without either
side knowing the other's schema. A test asserts that.

### Options

| Option | Meaning |
|---|---|
| `credentials` | The port above. Pass the host's storage to carry an existing authorization across. |
| `db` / `dbPath` | An open `node:sqlite` handle, or where to open one, if you have no port. |
| `provider` | Default adapter name. Defaults to `quickbooks`. |
| `quickbooks` | `{ clientId, clientSecret, redirectUri, env }`, falling back to `QBO_*` env vars. |
| `fetchImpl` | Injectable `fetch`, for tests. |

## A note on record shapes

`getOpenInvoices`, `getPaymentsSince`, `getCustomers` and `getOpenCreditMemos`
return records in QuickBooks' own shape (`CustomerRef.value`, `Balance`,
`DueDate`, `DocNumber`). That is deliberate: it is already the platform's
normalized shape — a non-QuickBooks adapter written against this interface maps
into it — and inventing a second one would mean rewriting business logic that
the move was explicitly not supposed to touch. `getArAging` is normalized
properly, because nothing consumed it before.

If a future adapter makes that shape awkward, normalize then, deliberately, and
migrate the agents in the same change.

## Tests

```
npm test
```

44 tests, one per guardrail. They are the specification — each fails loudly if
someone loosens the thing it guards. The aging tests run against a real
captured report, not only a hand-built one.
