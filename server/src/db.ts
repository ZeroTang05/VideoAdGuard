/** LMDB 缓存：直接用视频键查找 JSON 字符串，与 Worker 共用记录格式。 */

import { open, type RootDatabase } from 'lmdb';
import { join } from 'node:path';

const DB_PATH = process.env.DB_PATH || join(process.cwd(), 'data', 'cache.lmdb');

// AI 文案评分的键前缀，与 Worker 保持一致
export const AI_SCRIPT_KV_PREFIX = 'ai:';
const AI_COMMENT_REPORT_PREFIX = 'comment-ai-report:';
const AI_COMMENT_SHARED_PREFIX = 'comment-ai-shared:';

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

/** 同一个事务内累计请求次数，首次提交时发布 UID。 */
export function countAiCommentReport(uid: string): { count: number; shared: boolean } {
  const store = getDb();
  return store.transactionSync(() => {
    const key = AI_COMMENT_REPORT_PREFIX + uid;
    const count = Number(store.get(key) ?? '0') + 1;
    store.putSync(key, String(count));
    store.putSync(AI_COMMENT_SHARED_PREFIX + uid, '1');
    return { count, shared: true };
  });
}

/** 遍历已发布标记和旧版计数键，兼容阈值调整前的首次提交记录。 */
export function listSharedAiCommentUids(): string[] {
  const store = getDb();
  const uids = new Set<string>();
  const sharedKeys = store.getKeys({ start: AI_COMMENT_SHARED_PREFIX, end: 'comment-ai-shared;' });
  for (const key of sharedKeys) uids.add(key.slice(AI_COMMENT_SHARED_PREFIX.length));

  const reportKeys = store.getKeys({ start: AI_COMMENT_REPORT_PREFIX, end: 'comment-ai-report;' });
  for (const key of reportKeys) {
    const count = Number.parseInt(store.get(key) ?? '0', 10);
    if (Number.isSafeInteger(count) && count >= 1) uids.add(key.slice(AI_COMMENT_REPORT_PREFIX.length));
  }
  return [...uids];
}

/** 测试用：关闭连接。 */
export async function closeDb(): Promise<void> {
  await db?.close();
  db = undefined;
}
