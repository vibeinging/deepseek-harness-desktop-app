import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let sqliteSeq = 0;

const RETAIL_SQLITE_PY = String.raw`
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
try:
    db.executescript("""
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        tier TEXT NOT NULL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        order_date TEXT NOT NULL,
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );
    """)
    db.executemany(
        "INSERT INTO customers (id, name, city, tier) VALUES (?, ?, ?, ?)",
        [
            (1, "Alpha", "上海", "gold"),
            (2, "Beta", "北京", "silver"),
            (3, "Gamma", "深圳", "gold"),
        ],
    )
    db.executemany(
        "INSERT INTO orders (id, customer_id, amount, order_date) VALUES (?, ?, ?, ?)",
        [
            (101, 1, 120.5, "2024-01-05"),
            (102, 1, 320.0, "2024-01-20"),
            (103, 2, 88.8, "2024-02-14"),
            (104, 3, 640.2, "2024-03-08"),
        ],
    )
    db.commit()
finally:
    db.close()
`;

export function writeRetailSqliteFixture(name = 'retail.sqlite') {
  const safeName = String(name).replace(/[^A-Za-z0-9_.-]/g, '_');
  const filePath = path.join(tmpdir(), `dsh-eval-${Date.now()}-${++sqliteSeq}-${safeName}`);
  rmSync(filePath, { force: true });

  const result = spawnSync('python3', ['-c', RETAIL_SQLITE_PY, filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`failed to create sqlite fixture: ${result.stderr || result.stdout || result.status}`);
  }

  return filePath;
}
