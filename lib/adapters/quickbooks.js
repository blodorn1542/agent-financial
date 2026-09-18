'use strict';

/**
 * QuickBooks Online: OAuth 2.0 token handling + the read calls agents need.
 *
 * Moved out of nickel-collections lib/qbo.js at commit 9eebc3c. The logic is
 * the same; what changed is that it no longer reaches for a particular agent's
 * database or a particular agent's routes. Tokens come and go through the
 * injected credentials port, so a host that already has a company authorized
 * keeps that authorization - moving this code does not cost anyone a re-auth.
 *
 * HARD RULE (carried over from Nickel, non-negotiable): this adapter only ever
 * reads the books. Every call against /v3/company/... goes through get() below,
 * which takes no method argument and cannot be talked into a POST. The only
 * writes in this file are to Intuit's OAuth endpoints - tokens, not ledgers.
 * Chasing money and touching the books are two different jobs.
 */

const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
const PROVIDER = 'quickbooks';

/** Refresh this many ms before the access token actually expires. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

function create(ctx) {
  const { credentials, fetchImpl = fetch, settings = {} } = ctx;

  function env(name, fallback) {
    const v = settings[settingKey(name)] ?? process.env[name] ?? fallback;
    if (v === undefined) throw new Error('Missing required env var ' + name);
    return v;
  }

  /** QBO_CLIENT_ID -> clientId, so settings can be passed in camelCase. */
  function settingKey(name) {
    return name.replace(/^QBO_/, '').toLowerCase()
      .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
  }

  function apiBase() {
    const mode = (settings.env || process.env.QBO_ENV || 'sandbox').toLowerCase();
    return mode === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
  }

  function basicAuthHeader() {
    const raw = env('QBO_CLIENT_ID') + ':' + env('QBO_CLIENT_SECRET');
    return 'Basic ' + Buffer.from(raw).toString('base64');
  }

  /* --------------------------------------------------------------- OAuth -- */

  function authorizeUrl(state) {
    const params = new URLSearchParams({
      client_id: env('QBO_CLIENT_ID'),
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: env('QBO_REDIRECT_URI'),
      state,
    });
    return AUTH_URL + '?' + params.toString();
  }

  async function postTokenRequest(body) {
    const res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(body).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error('Intuit token endpoint ' + res.status + ': ' + text);
    return JSON.parse(text);
  }

  function shapeTokens(json, realmId) {
    const now = Date.now();
    return {
      realmId,
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      accessExpiresAt: now + (json.expires_in ?? 3600) * 1000,
      refreshExpiresAt: now + (json.x_refresh_token_expires_in ?? 8726400) * 1000,
    };
  }

  /** Exchange the code from the OAuth callback and persist the tokens. */
  async function exchangeCode(tenantId, code, realmId) {
    const json = await postTokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env('QBO_REDIRECT_URI'),
    });
    const tokens = shapeTokens(json, realmId);
    credentials.save(tenantId, PROVIDER, tokens);
    return tokens;
  }

  /**
   * Intuit rotates the refresh token on most refreshes, so the new one must be
   * persisted every time or the tenant silently falls off in ~100 days.
   */
  async function refreshTokens(tenantId, refreshToken, realmId) {
    const json = await postTokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const tokens = shapeTokens(json, realmId);
    if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
    credentials.save(tenantId, PROVIDER, tokens);
    return tokens;
  }

  /** A host's table may call the company file realm_id or external_id. Read either. */
  function realmOf(row) {
    return row?.realm_id ?? row?.realmId ?? row?.external_id ?? row?.externalId ?? null;
  }

  async function getValidAccessToken(tenantId) {
    const row = credentials.get(tenantId, PROVIDER);
    if (!row || !row.refresh_token) {
      throw new Error('Tenant "' + tenantId + '" has not connected QuickBooks yet');
    }
    if (row.refresh_expires_at && row.refresh_expires_at < Date.now()) {
      throw new Error('Tenant "' + tenantId + '" refresh token has expired - reconnect QuickBooks');
    }
    const fresh = row.access_token && row.access_expires_at &&
                  row.access_expires_at - REFRESH_SKEW_MS > Date.now();
    if (fresh) return { accessToken: row.access_token, realmId: realmOf(row) };

    const tokens = await refreshTokens(tenantId, row.refresh_token, realmOf(row));
    return { accessToken: tokens.accessToken, realmId: tokens.realmId };
  }

  async function revoke(tenantId) {
    const row = credentials.get(tenantId, PROVIDER);
    if (!row || !row.refresh_token) return false;
    const res = await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token: row.refresh_token }),
    });
    return res.ok;
  }

  function isConnected(tenantId) {
    return !!credentials.get(tenantId, PROVIDER)?.refresh_token;
  }

  /* ----------------------------------------------------------- API reads -- */

  /**
   * The only way this adapter talks to the company file. There is deliberately
   * no method parameter: a caller cannot pass 'POST', so no amount of wrapping
   * turns this into a write. Read-only is a property of the code, not a policy.
   */
  async function get(tenantId, pathWithQuery) {
    const { accessToken, realmId } = await getValidAccessToken(tenantId);
    if (!realmId) throw new Error('Tenant "' + tenantId + '" has no realmId on file');
    const sep = pathWithQuery.includes('?') ? '&' : '?';
    const url = apiBase() + '/v3/company/' + realmId + pathWithQuery + sep + 'minorversion=' + MINOR_VERSION;

    const res = await fetchImpl(url, {
      headers: { Authorization: 'Bearer ' + accessToken, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error('QuickBooks ' + res.status + ' on ' + pathWithQuery + ': ' + text.slice(0, 500));
    }
    return JSON.parse(text);
  }

  /** Run a QuickBooks query, paging through all results. */
  async function query(tenantId, statement, options) {
    const { pageSize = 500, maxPages = 40 } = options || {};
    const rows = [];
    let start = 1;
    for (let page = 0; page < maxPages; page++) {
      const paged = statement + ' STARTPOSITION ' + start + ' MAXRESULTS ' + pageSize;
      const json = await get(tenantId, '/query?query=' + encodeURIComponent(paged));
      const qr = json.QueryResponse || {};
      const key = Object.keys(qr).find((k) => Array.isArray(qr[k]));
      const batch = key ? qr[key] : [];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      start += batch.length;
    }
    return rows;
  }

  /** Every invoice with money still owed on it. */
  function getOpenInvoices(tenantId) {
    return query(tenantId, "SELECT * FROM Invoice WHERE Balance > '0'");
  }

  /** Unapplied credit memos - netted against a customer's balance before flagging. */
  function getOpenCreditMemos(tenantId) {
    return query(tenantId, "SELECT * FROM CreditMemo WHERE Balance > '0'");
  }

  /** Payments recorded on or after sinceDate (YYYY-MM-DD). The "already paid" guard. */
  function getPaymentsSince(tenantId, sinceDate) {
    return query(tenantId, "SELECT * FROM Payment WHERE TxnDate >= '" + sinceDate + "'");
  }

  function getCustomers(tenantId) {
    return query(tenantId, 'SELECT * FROM Customer WHERE Active = true');
  }

  /** Invoices raised since a date, for a host's good-payer judgement. */
  function getInvoicesSince(tenantId, sinceDate) {
    return query(tenantId, "SELECT * FROM Invoice WHERE TxnDate >= '" + sinceDate + "'");
  }

  /**
   * The A/R Aging Summary report - the same numbers the client sees on screen
   * in QuickBooks. The interface reconciles it against the open invoices; see
   * lib/aging.js for why the parsing is fussier than it looks.
   */
  async function getAgingReport(tenantId, options) {
    const { basis = 'Accrual', asOf, agingMethod } = options || {};
    const params = new URLSearchParams({ accounting_method: basis });
    if (asOf) params.set('report_date', asOf);
    if (agingMethod) params.set('aging_method', agingMethod); // Report_Date | Current
    return get(tenantId, '/reports/AgedReceivables?' + params.toString());
  }

  async function getCompanyInfo(tenantId) {
    const { realmId } = await getValidAccessToken(tenantId);
    return get(tenantId, '/companyinfo/' + realmId);
  }

  return {
    name: PROVIDER,
    provider: PROVIDER,

    /** Tokens, not ledgers. Kept apart from reads so the read surface stays clean. */
    auth: { authorizeUrl, exchangeCode, refreshTokens, getValidAccessToken, revoke, isConnected, SCOPE },

    /**
     * Everything the interface is allowed to call. Nothing here mutates the
     * books; there is no sibling `writes` object and there should never be one.
     */
    reads: {
      getOpenInvoices, getOpenCreditMemos, getPaymentsSince, getCustomers,
      getInvoicesSince, getAgingReport, getCompanyInfo,
    },

    apiBase,
  };
}

module.exports = { create, PROVIDER, SCOPE, MINOR_VERSION, REFRESH_SKEW_MS };
