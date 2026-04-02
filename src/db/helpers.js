/**
 * Shared DB helpers.
 */

import { getDb } from './sqlite.js';

/**
 * Replace all rows in a table within a transaction.
 * @param {string} table - table name
 * @param {string[]} columns - column names
 * @param {any[][]} rows - array of value arrays matching columns
 */
export function replaceAll(table, columns, rows) {
  const db = getDb();
  const clear = db.prepare(`DELETE FROM ${table}`);
  const placeholders = columns.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`);
  db.transaction((items) => {
    clear.run();
    for (const row of items) insert.run(...row);
  })(rows);
}
