import { describe, expect, it } from 'vitest';
import worker, { type Env } from './index';
import { AI_COMMENT_SHARED_PREFIX } from './ai-comment-blocklist';

class MemoryKv {
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
    return {
      keys: names.map(name => ({ name })),
      list_complete: true,
    };
  }
}

function createEnv() {
  return { VIDEO_AD_GUARD_KV: new MemoryKv() } as unknown as Env;
}

describe('Cloudflare Worker 疑似 AI 评论作者接口', () => {
  it('两次提交后 GET 返回共享 UID', async () => {
    const env = createEnv();
    const request = (body: string) => worker.fetch(new Request('https://worker.test/api/ai-comment-blocklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.10' },
      body,
    }), env);

    expect((await (await request(JSON.stringify({ uid: '3546999999999999' }))).json()).data).toEqual({
      uid: '3546999999999999', count: 1, shared: false,
    });
    expect((await (await request(JSON.stringify({ uid: '3546999999999999' }))).json()).data).toEqual({
      uid: '3546999999999999', count: 2, shared: true,
    });

    const response = await worker.fetch(new Request('https://worker.test/api/ai-comment-blocklist', {
      headers: { 'CF-Connecting-IP': '198.51.100.10' },
    }), env);
    expect((await response.json()).data.uids).toEqual(['3546999999999999']);
  });

  it('拒绝非法 UID', async () => {
    const response = await worker.fetch(new Request('https://worker.test/api/ai-comment-blocklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.11' },
      body: JSON.stringify({ uid: '0' }),
    }), createEnv());
    expect(response.status).toBe(400);
  });

  it('只读取共享前缀键', async () => {
    const env = createEnv();
    await env.VIDEO_AD_GUARD_KV.put(AI_COMMENT_SHARED_PREFIX + '100', '1');
    await env.VIDEO_AD_GUARD_KV.put('comment-ai-report:200', '1');
    const response = await worker.fetch(new Request('https://worker.test/api/ai-comment-blocklist'), env);
    expect((await response.json()).data.uids).toEqual(['100']);
  });
});
