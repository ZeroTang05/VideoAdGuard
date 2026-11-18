/** 验证 SQLite 到 LMDB 的迁移能保留既有缓存，并保护目标库。 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openCacheDb } from './db';
import { migrateSqlite } from './migrate-sqlite';

let directory: string;
let sourcePath: string;
let targetPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vag-migrate-test-'));
  sourcePath = join(directory, 'cache.sqlite3');
  targetPath = join(directory, 'cache.lmdb');
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function seedSqlite(entries: Array<[string, string | Uint8Array]>): void {
  const source = new DatabaseSync(sourcePath);
  try {
    source.exec('PRAGMA journal_mode = WAL');
    source.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const insert = source.prepare('INSERT INTO kv VALUES (?, ?)');
    for (const [key, value] of entries) insert.run(key, value);
  } finally {
    source.close();
  }
}

it('导入两类记录，重开数据库后保留原有的 JSON 文本', async () => {
  const entries: Array<[string, string]> = [
    ['BV1xx411c7mD', '{"goodName":["商品甲"],"adTimeRanges":[[10,30]]}'],
    ['ai:BV1xx411c7mD', '{"aiScore":87,"criteriaVersion":3}'],
  ];
  seedSqlite(entries);

  expect(await migrateSqlite(sourcePath, targetPath)).toBe(2);
  await expect(migrateSqlite(sourcePath, targetPath)).rejects.toThrow('目标 LMDB 已有缓存记录');
  const target = openCacheDb(targetPath);
  try {
    for (const [key, value] of entries) expect(target.get(key)).toBe(value);
  } finally {
    await target.close();
  }
});

it('导入中途失败时，目标库没有部分写入的记录', async () => {
  seedSqlite([
    ['BV1xx411c7mD', '{}'],
    ['ai:BV1xx411c7mD', Uint8Array.of(1)],
  ]);

  await expect(migrateSqlite(sourcePath, targetPath)).rejects.toThrow('键或值不是文本');
  const target = openCacheDb(targetPath);
  try {
    expect(target.getCount()).toBe(0);
  } finally {
    await target.close();
  }
});
