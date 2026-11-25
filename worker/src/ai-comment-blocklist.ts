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

/** 读取所有已达到共享条件的 UID，处理 KV list 的分页结果。 */
export async function listSharedCommentUids(store: AiCommentBlocklistStore): Promise<string[]> {
  const uids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix: AI_COMMENT_SHARED_PREFIX, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) uids.push(key.name.slice(AI_COMMENT_SHARED_PREFIX.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return uids;
}

/** 每次有效提交独立计数，第二次提交后加入共享名单。 */
export async function countCommentReport(
  store: AiCommentBlocklistStore,
  uid: string,
): Promise<{ count: number; shared: boolean }> {
  const reportKey = AI_COMMENT_REPORT_PREFIX + uid;
  const previous = Number.parseInt(await store.get(reportKey) ?? '0', 10);
  const count = Number.isSafeInteger(previous) && previous >= 0 ? previous + 1 : 1;
  await store.put(reportKey, String(count));
  if (count >= 2) await store.put(AI_COMMENT_SHARED_PREFIX + uid, '1');
  return { count, shared: count >= 2 };
}
