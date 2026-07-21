/* ============================================================
   Txform.ph — server/migrate.js

   Brings an existing database up to match schema.sql.

   WHY THIS EXISTS
   schema.sql is all `CREATE TABLE IF NOT EXISTS`, which creates a
   missing table but does NOTHING to a table that already exists. Adding
   a column to schema.sql therefore had no effect on a live database —
   and the failure was not at deploy time but at query time: the service
   started fine, then every request touching the new column returned 500.

   That is exactly what happened when `users.status` shipped: the auth
   service came up healthy and then 500'd on sign-in, because the column
   the new code selected did not exist. Recreating the database hid this
   while it was empty; once it held a real firm, it could not.

   WHAT IT DOES
   Reads the CREATE TABLE statements in schema.sql, compares each table's
   columns against the live database, and ALTERs in whatever is missing.
   Additive only, by design:

     - it never drops, renames, retypes or reorders a column
     - it never touches a row
     - it is idempotent, so running it on every boot is a no-op once the
       database is current

   Anything beyond adding a column (a rename, a type change, a backfill)
   is a real migration and wants a real script — this deliberately will
   not attempt it, and says so rather than guessing.

   NOT-NULL COLUMNS
   SQLite refuses `ADD COLUMN ... NOT NULL` without a default, because
   existing rows would have nowhere to go. Every NOT NULL column in
   schema.sql already carries a DEFAULT for that reason; one that does
   not is reported and skipped rather than crashing the service on boot.
   ============================================================ */
'use strict';

// Split schema.sql into { tableName: "col defs..." }. Deliberately a
// narrow parser: it only understands the shape this project's schema
// actually uses, and ignores indexes, pragmas and comments.
function parseSchemaTables(sql) {
  const tables = {};
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  let m;
  while ((m = re.exec(sql)) !== null) tables[m[1]] = m[2];
  return tables;
}

// Column definitions from one table body, in order. Skips comment-only
// lines and table-level constraints (UNIQUE(...), PRIMARY KEY(...), ...)
// which are not columns and cannot be added later anyway.
function parseColumns(body) {
  const CONSTRAINT = /^(UNIQUE|PRIMARY|FOREIGN|CHECK|CONSTRAINT)\b/i;
  const out = [];
  let depth = 0, current = '';

  // Split on either ending: the repo normalises to LF, but a checkout on
  // Windows leaves CRLF, and a stray \r makes a stripped comment line look
  // non-empty — which silently glues the next column onto this one.
  String(body).split(/\r?\n/).forEach(function (rawLine) {
    const line = rawLine.replace(/--.*$/, '').trim();   // strip trailing comment
    if (!line) return;
    current += (current ? ' ' : '') + line;
    // Only split on commas at depth 0, so DEFAULT (datetime('now')) and
    // REFERENCES x(y) survive intact.
    for (const ch of line) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth === 0 && current.endsWith(',')) {
      const def = current.slice(0, -1).trim();
      current = '';
      if (def && !CONSTRAINT.test(def)) out.push(def);
    }
  });
  const tail = current.trim();
  if (tail && !CONSTRAINT.test(tail)) out.push(tail);

  return out.map(function (def) {
    return { name: def.split(/\s+/)[0], def: def };
  }).filter(function (c) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name); });
}

// SQLite cannot add a NOT NULL column without a DEFAULT — existing rows
// would have no value for it.
function canAddColumn(def) {
  const notNull = /\bNOT\s+NULL\b/i.test(def);
  const hasDefault = /\bDEFAULT\b/i.test(def);
  if (notNull && !hasDefault) {
    return { ok: false, reason: 'NOT NULL without DEFAULT — needs a real migration, not an ADD COLUMN' };
  }
  if (/\bPRIMARY\s+KEY\b/i.test(def)) return { ok: false, reason: 'PRIMARY KEY cannot be added to an existing table' };
  // SQLite also refuses a non-constant default — DEFAULT (datetime('now'))
  // and friends. Dropping the default to force it through would be worse
  // than stopping: a stale database would then insert NULL where a fresh
  // one writes a timestamp, and the two would quietly disagree forever.
  if (/\bDEFAULT\s*\(/i.test(def)) {
    return { ok: false, reason: 'non-constant DEFAULT (e.g. datetime(\'now\')) — SQLite cannot ADD COLUMN with one; needs a real migration' };
  }
  // SQLite cannot ADD COLUMN ... UNIQUE, but the constraint is not lost:
  // add the column plain and enforce it with a unique index, which is what
  // the inline constraint compiles to anyway.
  if (/\bUNIQUE\b/i.test(def)) return { ok: true, needsUniqueIndex: true };
  return { ok: true };
}

// Work out what is missing. Pure: takes the schema text and a lookup of
// the live columns, returns the ALTER statements to run. Tested without
// a database.
function planMigration(schemaSql, liveColumnsByTable) {
  const plan = [];
  const skipped = [];
  const tables = parseSchemaTables(schemaSql);

  Object.keys(tables).forEach(function (table) {
    const live = liveColumnsByTable[table];
    if (!live) return;   // table absent entirely — CREATE TABLE handles it
    const have = new Set(live);
    parseColumns(tables[table]).forEach(function (col) {
      if (have.has(col.name)) return;
      const check = canAddColumn(col.def);
      if (!check.ok) {
        skipped.push({ table: table, column: col.name, reason: check.reason });
        return;
      }
      // Drop the inline UNIQUE from the ADD COLUMN and re-impose it as an
      // index, so the constraint survives a migration.
      const def = check.needsUniqueIndex ? col.def.replace(/\s*\bUNIQUE\b/i, '') : col.def;
      const step = { table: table, column: col.name, sql: 'ALTER TABLE ' + table + ' ADD COLUMN ' + def };
      if (check.needsUniqueIndex) {
        step.indexSql = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_' + table + '_' + col.name +
          '_unique ON ' + table + '(' + col.name + ')';
      }
      plan.push(step);
    });
  });

  return { plan: plan, skipped: skipped };
}

// Apply it. Returns what was done so the caller can log it — a silent
// migration is how the original bug stayed invisible.
function migrate(db, schemaSql, log) {
  const say = log || function () {};
  const liveTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(function (r) { return r.name; });

  const liveColumnsByTable = {};
  liveTables.forEach(function (t) {
    liveColumnsByTable[t] = db.prepare('SELECT name FROM pragma_table_info(?)').all(t)
      .map(function (r) { return r.name; });
  });

  const { plan, skipped } = planMigration(schemaSql, liveColumnsByTable);

  plan.forEach(function (step) {
    db.exec(step.sql);
    if (step.indexSql) db.exec(step.indexSql);
    say('[migrate] added ' + step.table + '.' + step.column + (step.indexSql ? ' (+ unique index)' : ''));
  });

  // Loud: a column we cannot add automatically means the code may be
  // about to query something that is not there.
  skipped.forEach(function (s) {
    say('[migrate] WARNING: cannot add ' + s.table + '.' + s.column + ' — ' + s.reason);
  });

  return { added: plan.length, plan: plan, skipped: skipped };
}

module.exports = { migrate, planMigration, parseSchemaTables, parseColumns, canAddColumn };
