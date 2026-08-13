import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
const db = new DatabaseSync(join(homedir(), '.dsh', 'local.db'), { readOnly: true });
const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const parts = [
  '-- DSH desktop local SQLite schema (built-in DDL, bootstraps with CREATE TABLE IF NOT EXISTS).',
  '-- Exported automatically from local.db to remove remote Vastbase dependency. Total tables: ' + tables.length,
  '-- Regenerate with: node scripts/gen_schema.mjs',
  '',
];
for (const t of tables) {
  // CREATE TABLE "x" → CREATE TABLE IF NOT EXISTS "x" (idempotent)
  let ddl = t.sql.replace(/^CREATE TABLE\s+/i, 'CREATE TABLE IF NOT EXISTS ');
  parts.push(ddl.trim() + ';');
}
const out = join(process.cwd(), 'db', 'schema.sql');
import('node:fs').then(fs => { fs.mkdirSync(join(process.cwd(), 'db'), { recursive: true }); });
writeFileSync(out, parts.join('\n') + '\n', 'utf8');
console.log('生成', out, '—', tables.length, '表,', parts.join('\n').length, 'chars');
