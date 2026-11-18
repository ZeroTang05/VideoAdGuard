/**
 * SQLite KV 存储：模拟 Cloudflare KV 的键值语义（key → JSON 字符串）。
 * 表结构刻意保持 KV 形态（而非关系列），使 Worker 与自建服务的数据行为完全一致，
 * 记录格式变化（增删字段）无需迁移表结构。
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'cache.sqlite3');

// AI 文案评分的 KV 键前缀，与 worker/src/index.ts 保持一致
export const AI_SCRIPT_KV_PREFIX = 'ai:';

let db: Database.Database;

/** 初始化数据库连接（幂等），创建表和索引 */
export function initDb(dbPath = DB_PATH): Database.Database {
  if (db) return db;

  // 数据目录不存在时自动创建
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // 读写并发友好
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  return db;
}

export function kvGet(key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function kvPut(key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** 测试用：关闭连接 */
export function closeDb(): void {
  db?.close();
  db = undefined as unknown as Database.Database;
}
