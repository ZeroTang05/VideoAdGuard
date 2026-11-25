/** Cloudflare KV 中的疑似 AI 评论作者共享名单。 */

export const AI_COMMENT_REPORT_PREFIX = 'comment-ai-report:';
export const AI_COMMENT_SHARED_PREFIX = 'comment-ai-shared:';

export interface AiCommentBlocklistStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export function isValidCommentUid(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

/** 读取共享标记和旧版计数键，兼容阈值调整前的首次提交记录。 */
export async function listSharedCommentUids(store: AiCommentBlocklistStore): Promise<string[]> {
  const listKeys = async (prefix: string): Promise<string[]> => {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
      keys.push(...page.keys.map(key => key.name));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return keys;
  };

  const sharedKeys = await listKeys(AI_COMMENT_SHARED_PREFIX);
  const reportKeys = await listKeys(AI_COMMENT_REPORT_PREFIX);
  const reportUids = await Promise.all(reportKeys.map(async key => {
    const count = Number.parseInt(await store.get(key) ?? '0', 10);
    return Number.isSafeInteger(count) && count >= 1
      ? key.slice(AI_COMMENT_REPORT_PREFIX.length)
      : undefined;
  }));
  return [...new Set([
    ...sharedKeys.map(key => key.slice(AI_COMMENT_SHARED_PREFIX.length)),
    ...reportUids.filter((uid): uid is string => uid !== undefined),
  ])];
}

/** 每次有效提交独立计数，首次提交后加入共享名单。 */
export async function countCommentReport(
  store: AiCommentBlocklistStore,
  uid: string,
): Promise<{ count: number; shared: boolean }> {
  const reportKey = AI_COMMENT_REPORT_PREFIX + uid;
  const previous = Number.parseInt(await store.get(reportKey) ?? '0', 10);
  const count = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
  await store.put(reportKey, String(count));
  await store.put(AI_COMMENT_SHARED_PREFIX + uid, '1');
  return { count, shared: true };
}
