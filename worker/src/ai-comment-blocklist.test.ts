import { describe, expect, it } from 'vitest';
import {
  AI_COMMENT_SHARED_PREFIX,
  countCommentReport,
  isValidCommentUid,
  listSharedCommentUids,
  type AiCommentBlocklistStore,
} from './ai-comment-blocklist';

class MemoryStore implements AiCommentBlocklistStore {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async list(options: { prefix?: string; cursor?: string } = {}) {
    const names = [...this.values.keys()]
      .filter(key => !options.prefix || key.startsWith(options.prefix))
      .sort();
    const offset = options.cursor ? Number(options.cursor) : 0;
    const page = names.slice(offset, offset + 2);
    const next = offset + page.length;
    return {
      keys: page.map(name => ({ name })),
      list_complete: next >= names.length,
      cursor: next < names.length ? String(next) : undefined,
    };
  }
}

describe('疑似 AI 评论作者共享名单', () => {
  it('校验 UID 格式', () => {
    expect(isValidCommentUid('1')).toBe(true);
    expect(isValidCommentUid('3546999999999999')).toBe(true);
    expect(isValidCommentUid('0')).toBe(false);
    expect(isValidCommentUid('abc')).toBe(false);
    expect(isValidCommentUid(123)).toBe(false);
  });

  it('首次提交后发布 UID', async () => {
    const store = new MemoryStore();
    expect(await countCommentReport(store, '3546999999999999')).toEqual({ count: 1, shared: true });
    expect(await listSharedCommentUids(store)).toEqual(['3546999999999999']);
    expect(await countCommentReport(store, '3546999999999999')).toEqual({ count: 2, shared: true });
    expect(await listSharedCommentUids(store)).toEqual(['3546999999999999']);
  });

  it('处理共享名单分页并兼容旧版计数键', async () => {
    const store = new MemoryStore();
    await store.put(AI_COMMENT_SHARED_PREFIX + '100', '1');
    await store.put(AI_COMMENT_SHARED_PREFIX + '200', '1');
    await store.put(AI_COMMENT_SHARED_PREFIX + '300', '1');
    await store.put('comment-ai-report:400', '1');
    expect(await listSharedCommentUids(store)).toEqual(['100', '200', '300', '400']);
  });
});
