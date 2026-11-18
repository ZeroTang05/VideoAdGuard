/** LMDB 缓存：直接用视频键查找 JSON 字符串，与 Worker 共用记录格式。 */

import { open, type RootDatabase } from 'lmdb';
import { join } from 'node:path';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'cache.lmdb');

// AI 文案评分的键前缀，与 Worker 保持一致
export const AI_SCRIPT_KV_PREFIX = 'ai:';

let db: RootDatabase<string, string> | undefined;

/** 运行时和迁移脚本按相同的目录结构和编码打开 LMDB。 */
export function openCacheDb(path: string): RootDatabase<string, string> {
  return open<string, string>({ path, noSubdir: false, encoding: 'string' });
}

/** 启动时打开数据库，同一进程复用一个连接。 */
export function initDb(dbPath = DB_PATH): RootDatabase<string, string> {
  return db ??= openCacheDb(dbPath);
}

function getDb(): RootDatabase<string, string> {
  if (!db) throw new Error('缓存数据库尚未初始化');
  return db;
}

export function kvGet(key: string): string | null {
  return getDb().get(key) ?? null;
}

export function kvPut(key: string, value: string): void {
  getDb().putSync(key, value);
}

/** 测试用：关闭连接。 */
export async function closeDb(): Promise<void> {
  await db?.close();
  db = undefined;
}
