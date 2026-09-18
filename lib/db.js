'use strict';

/**
 * Opening a database is the host's job, not this package's.
 *
 * createFinancial({ credentials }) is the normal path: an agent that already
 * stores OAuth tokens passes its own storage in, and this package writes
 * nowhere new - which is also how an already-authorized company survives the
 * move. This helper exists for the standalone case: a host with no storage of
 * its own that just wants the tokens kept somewhere.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(dbPath) {
  if (!dbPath) {
    throw new Error('createFinancial needs a credentials port, a db handle, or a dbPath');
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

module.exports = { openDatabase };
