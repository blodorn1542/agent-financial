'use strict';

/**
 * agent-financial - the shared money-reading layer for the agent platform.
 *
 * One read-only interface agents call; the books behind it are interchangeable
 * adapters. This package knows nothing about any agent that uses it: no
 * collections tiers, no findings, no thresholds. The dependency runs one way.
 *
 *   const { createFinancial } = require('agent-financial');
 *
 *   // sharing the host's existing OAuth storage, so nobody re-authorizes
 *   const money = createFinancial({ credentials });
 *
 *   // or fully self-contained
 *   const money = createFinancial({ dbPath: '/data/financial.db' });
 *
 *   const aging = await money.getArAging({ tenant: 'elite-pools' });
 *
 * There are no write methods. That is structural - see lib/interface.js - and
 * it is how "an agent never touches the books" stops being one agent's
 * discipline and becomes a property of the platform.
 */

const { openDatabase } = require('./lib/db');
const { createCredentials, assertCredentialsPort } = require('./lib/credentials');
const {
  createInterface, assertReadOnly, normalizeBuckets, METHODS,
} = require('./lib/interface');
const { parseAgingReport, agingReportTotal, reconcile, round } = require('./lib/aging');
const quickbooks = require('./lib/adapters/quickbooks');

/** The adapters this package ships. Xero would be one more entry here. */
const ADAPTER_MODULES = { quickbooks };

/**
 * @param {object}   options
 * @param {object}  [options.credentials] credential port; see lib/credentials.js.
 *                                        Pass the host's own storage to carry an
 *                                        existing authorization across untouched.
 * @param {object}  [options.db]          an open node:sqlite handle, if you want the
 *                                        default port to live in your database
 * @param {string}  [options.dbPath]      where to open one, if you have neither
 * @param {string}  [options.provider]    default adapter name ('quickbooks')
 * @param {object}  [options.quickbooks]  { clientId, clientSecret, redirectUri, env },
 *                                        falling back to QBO_* env vars
 * @param {function}[options.fetchImpl]   injectable fetch, for tests
 */
function createFinancial(options = {}) {
  const {
    credentials, db, dbPath, provider, fetchImpl = fetch,
  } = options;

  const creds = credentials
    ? assertCredentialsPort(credentials)
    : createCredentials(db || openDatabase(dbPath));

  const ctx = { credentials: creds, fetchImpl };
  const adapters = Object.fromEntries(
    Object.entries(ADAPTER_MODULES).map(([name, mod]) => [
      name,
      assertReadOnly(mod.create({ ...ctx, settings: options[name] || {} })),
    ])
  );

  const api = createInterface({ adapters, defaultProvider: provider });

  // Frozen, like the interface it spreads. Without this the freeze in
  // lib/interface.js would be undone right here: spreading a frozen object
  // produces an extensible one, and what an agent actually holds is this.
  return Object.freeze({
    ...api,
    adapters,
    credentials: creds,
    /** A host doing the OAuth dance needs the provider's own auth methods. */
    auth: (name) => api.adapterFor(name).auth,
    adapter: (name) => api.adapterFor(name),
  });
}

module.exports = {
  createFinancial,
  // Pure helpers, usable without constructing anything.
  parseAgingReport, agingReportTotal, reconcile, round, normalizeBuckets,
  createCredentials, assertCredentialsPort, assertReadOnly, openDatabase,
  METHODS,
  adapters: ADAPTER_MODULES,
};
