'use strict';

/**
 * Where a tenant's accounting credentials live.
 *
 * This is a port with a working default, the same shape agent-comms uses. It
 * exists for one reason above all others: a host that has ALREADY authorized a
 * company must not be made to re-authorize because the code moved house.
 * Nickel's sandbox realm was connected before this package existed; Nickel
 * passes a port backed by its own `tenants` table and the adapter reads the
 * row that is already there.
 *
 * The port is three functions:
 *
 *   get(tenantId, provider)           -> the stored row, or null
 *   save(tenantId, provider, tokens)  tokens: { realmId, externalId, externalName,
 *                                      accessToken, refreshToken,
 *                                      accessExpiresAt, refreshExpiresAt }
 *   remove(tenantId, provider)
 *
 * Reads come back in snake_case - access_token, refresh_token,
 * access_expires_at, refresh_expires_at, realm_id - because that is what a
 * SQLite row looks like. A host backed by SQL implements this port by handing
 * over its existing row-returning function instead of remapping every field.
 *
 * `realm_id` is QuickBooks' word for the company file. A host whose table
 * calls it something else can return `external_id` instead; the adapter reads
 * either.
 */

function createCredentials(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS financial_connections (
      tenant_id      TEXT NOT NULL,
      provider       TEXT NOT NULL,
      realm_id       TEXT,
      external_name  TEXT,
      access_token   TEXT,
      refresh_token  TEXT,
      access_expires_at   INTEGER,
      refresh_expires_at  INTEGER,
      connected_at   TEXT,
      updated_at     TEXT,
      PRIMARY KEY (tenant_id, provider)
    );
  `);

  function get(tenantId, provider) {
    return db.prepare(
      'SELECT * FROM financial_connections WHERE tenant_id = ? AND provider = ?'
    ).get(tenantId, provider) ?? null;
  }

  function save(tenantId, provider, tokens) {
    const now = new Date().toISOString();
    const existing = get(tenantId, provider);
    db.prepare(`
      INSERT INTO financial_connections (tenant_id, provider, realm_id, external_name,
        access_token, refresh_token, access_expires_at, refresh_expires_at,
        connected_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, provider) DO UPDATE SET
        realm_id = COALESCE(excluded.realm_id, financial_connections.realm_id),
        external_name = COALESCE(excluded.external_name, financial_connections.external_name),
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        access_expires_at = excluded.access_expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        updated_at = excluded.updated_at
    `).run(
      tenantId, provider,
      tokens.realmId ?? tokens.externalId ?? null,
      tokens.externalName ?? null,
      tokens.accessToken ?? null, tokens.refreshToken ?? null,
      tokens.accessExpiresAt ?? null, tokens.refreshExpiresAt ?? null,
      existing?.connected_at ?? now, now,
    );
  }

  function remove(tenantId, provider) {
    db.prepare('DELETE FROM financial_connections WHERE tenant_id = ? AND provider = ?')
      .run(tenantId, provider);
  }

  return { get, save, remove };
}

/** Fail at construction, clearly, when a host passes something that is not the port. */
function assertCredentialsPort(c) {
  for (const fn of ['get', 'save', 'remove']) {
    if (typeof c?.[fn] !== 'function') {
      throw new Error('credentials port is missing ' + fn + '(). It needs get(tenantId, ' +
        'provider), save(tenantId, provider, tokens) and remove(tenantId, provider).');
    }
  }
  return c;
}

module.exports = { createCredentials, assertCredentialsPort };
