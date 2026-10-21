// db/index.js
// Turso (libSQL) — a hosted, SQLite-compatible database with a real free
// tier and no ephemeral-disk problem, unlike Render/Vercel's free compute.
//
// This file is a thin async shim over @libsql/client shaped to look like
// better-sqlite3's API (db.prepare(sql).get/.all/.run) so the rest of the
// app didn't need a full rewrite — just "await" added at each call site.
// The one real difference: db.transaction() here takes an ARRAY of
// {sql, args} statements to run atomically, not a synchronous callback
// (Turso's transactions are network calls, so a sync callback isn't
// possible — see routes/public.js for example usage).
require('dotenv').config();
const { createClient } = require('@libsql/client');

function normalizeArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

// Builds one Turso connection + the same better-sqlite3-shaped shim as
// before. Factored out so we can create two of these (real + demo)
// without duplicating the whole file.
function makeDb(url, authToken) {
  const client = createClient({ url, authToken, intMode: 'number' });

  function prepare(sql) {
    return {
      async get(...args) {
        const result = await client.execute({ sql, args: normalizeArgs(args) });
        return result.rows[0];
      },
      async all(...args) {
        const result = await client.execute({ sql, args: normalizeArgs(args) });
        return result.rows;
      },
      async run(...args) {
        const result = await client.execute({ sql, args: normalizeArgs(args) });
        return {
          changes: Number(result.rowsAffected),
          lastInsertRowid: Number(result.lastInsertRowid)
        };
      }
    };
  }

  async function exec(sqlText) {
    const withoutComments = sqlText
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');
    const statements = withoutComments.split(';').map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
  }

  async function transaction(statements) {
    const tx = await client.transaction('write');
    try {
      for (const { sql, args } of statements) {
        await tx.execute({ sql, args: args || [] });
      }
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }

  return { prepare, exec, transaction, client };
}

const real = makeDb(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN);

// Demo DB is entirely optional — if you haven't set these two env vars
// yet, `db.demo` is just null and nothing else in the app is affected.
const demo = (process.env.TURSO_DEMO_DATABASE_URL && process.env.TURSO_DEMO_AUTH_TOKEN)
  ? makeDb(process.env.TURSO_DEMO_DATABASE_URL, process.env.TURSO_DEMO_AUTH_TOKEN)
  : null;

// Spreading `real` at the top level means every existing call site in
// the app — db.prepare(...), db.exec(...), db.transaction(...) — keeps
// working exactly as before, always against the real database.
module.exports = { ...real, real, demo };
