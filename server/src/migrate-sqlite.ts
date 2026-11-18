/** 一次性导入 SQLite 缓存，原样迁移键和 JSON 文本。 */

import { DatabaseSync } from 'node:sqlite';
import { openCacheDb } from './db';

/** 只读打开源库，用一次 LMDB 事务导入空目标库。 */
export async function migrateSqlite(sourcePath: string, targetPath: string): Promise<number> {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const rows = source.prepare('SELECT key, value FROM kv');
    const target = openCacheDb(targetPath);
    try {
      return target.transactionSync(() => {
        if (target.getCount({ limit: 1 }) > 0) {
          throw new Error(`目标 LMDB 已有缓存记录：${targetPath}`);
        }
        let count = 0;
        for (const { key, value } of rows.iterate()) {
          if (typeof key !== 'string' || typeof value !== 'string') {
            throw new Error(`SQLite 缓存第 ${count + 1} 条记录的键或值不是文本`);
          }
          target.putSync(key, value);
          count += 1;
        }
        return count;
      });
    } finally {
      await target.close();
    }
  } finally {
    source.close();
  }
}

async function main(): Promise<void> {
  const [sourcePath, targetPath] = process.argv.slice(2);
  if (!sourcePath || !targetPath) {
    throw new Error('用法：node dist/migrate-sqlite.js <SQLite 文件路径> <LMDB 目录路径>');
  }
  const count = await migrateSqlite(sourcePath, targetPath);
  console.log(`已导入 ${count} 条缓存记录到 ${targetPath}`);
}

if (require.main === module) void main();
