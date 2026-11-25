/** 自建缓存服务 API 测试：路由行为与 Cloudflare Worker 逐一对齐。 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, initDb } from './index';
import { RATE_LIMITS } from './rateLimit';
import { closeDb } from './db';

// 测试执行远快于真实用户，放开限流避免测试互相撞 429
for (const limit of Object.values(RATE_LIMITS)) {
  limit.windowMs = 10;
  limit.max = 10_000;
}

let appWithDb: express.Express;
const testDir = mkdtempSync(join(tmpdir(), 'vag-server-test-'));

beforeAll(() => {
  initDb(join(testDir, 'cache.lmdb'));
  appWithDb = app;
});

afterAll(async () => {
  await closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

const adBody = {
  bvid: 'BV1xx411c7mD',
  exist: true,
  goodName: ['商品甲'],
  adTimeRanges: [[10, 30]],
  model: 'deepseek-chat',
  provider: 'openai',
  detectedAt: Date.now(),
  isDetectionConfident: true,
  accuracy: 'accurate',
  source: 'ai',
  clientVersion: '1.4.3',
};

describe('自建缓存服务 API', () => {
  it('健康检查返回服务信息', async () => {
    const res = await request(appWithDb).get('/');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('首次提交立即发布 UID，同来源的并发提交各计一次', async () => {
    const path = '/api/ai-comment-blocklist';
    const uid = '3546999999999999';
    const first = await request(appWithDb).post(path).send({ uid });
    expect(first.body.data).toEqual({ uid, count: 1, shared: true });
    expect((await request(appWithDb).get(path)).body.data.uids).toContain(uid);

    const responses = await Promise.all([1, 2].map(() => request(appWithDb).post(path).send({ uid })));
    expect(responses.map(result => result.body.data.count).sort()).toEqual([2, 3]);
    expect(responses.every(result => result.body.data.shared)).toBe(true);
    expect((await request(appWithDb).get(path)).body.data.uids.filter((item: string) => item === uid)).toEqual([uid]);
    expect((await request(appWithDb).post(path).send({ uid: 123 })).status).toBe(400);
  });

  it('POST /api/cache 保存后 GET 可查回', async () => {
    const save = await request(appWithDb).post('/api/cache').send(adBody);
    expect(save.body.success).toBe(true);

    const query = await request(appWithDb).get(`/api/cache/${adBody.bvid}`);
    expect(query.body.exists).toBe(true);
    expect(query.body.data.goodName).toEqual(['商品甲']);
  });

  it('GET /api/cache 不返回 inaccurate 记录', async () => {
    await request(appWithDb).post('/api/cache').send({ ...adBody, bvid: 'BV1yy411c7mD', accuracy: 'inaccurate' });
    const query = await request(appWithDb).get('/api/cache/BV1yy411c7mD');
    expect(query.body.exists).toBe(false);
    expect(query.body.data).toBeNull();
  });

  it('POST /api/cache 无记录时创建，有记录时按验证结果覆盖', async () => {
    await request(appWithDb).post('/api/cache').send({
      ...adBody, bvid: 'BV1zz411c7mD', detectedAt: 111,
    });
    // 第二次保存缺 model 等字段：验证默认值覆盖旧值，服务端管理的 version 保留
    await request(appWithDb).post('/api/cache').send({
      bvid: 'BV1zz411c7mD', exist: false, goodName: [], adTimeRanges: [[5, 8]], detectedAt: 222,
    });
    const query = await request(appWithDb).get('/api/cache/BV1zz411c7mD');
    expect(query.body.data.detectedAt).toBe(222);
    expect(query.body.data.model).toBe('unknown'); // 缺失字段按验证默认值覆盖
    expect(query.body.data.version).toBe(1); // 服务端写入的字段不被客户端数据冲掉
  });

  it('同一个 BV 保存多个分 P，重测与旧版写入都保留其他分 P', async () => {
    const bvid = 'BV17F411T7Ao';
    const p1 = '25761288170';
    const p2 = '25761349680';
    const write = (body: object) => request(appWithDb).post('/api/cache/part').send({ ...adBody, bvid, ...body });
    expect((await request(appWithDb).post('/api/cache').send({ ...adBody, bvid })).status).toBe(200);
    expect((await write({ cid: p1, page: 1, adTimeRanges: [[20, 30]] })).status).toBe(200);
    expect((await write({ cid: p2, page: 2, exist: false, adTimeRanges: [] })).status).toBe(200);
    expect((await write({ cid: p1, page: 1, adTimeRanges: [[20, 40]] })).status).toBe(200);
    expect((await write({ cid: '0', page: 1 })).status).toBe(400);

    const query = await request(appWithDb).get(`/api/cache/${bvid}?parts=1`);
    expect(query.body).toMatchObject({
      data: { adTimeRanges: [[10, 30]] },
      parts: { [p1]: { adTimeRanges: [[20, 40]] }, [p2]: { exist: false, adTimeRanges: [] } },
    });
    expect((await request(appWithDb).post('/api/cache').send({ ...adBody, bvid, adTimeRanges: [[60, 80]] })).status).toBe(200);
    const legacy = await request(appWithDb).get(`/api/cache/${bvid}`);
    expect(legacy.body.data.adTimeRanges).toEqual([[60, 80]]);
    expect(legacy.body).not.toHaveProperty('parts');
    const batch = await request(appWithDb).post('/api/batch').send({ bvids: [bvid] });
    expect(batch.body.data[bvid].ad.adTimeRanges).toEqual([[20, 40]]);
  });

  it('拒绝非法 BV 号与非法广告区间', async () => {
    const badBvid = await request(appWithDb).post('/api/cache').send({ ...adBody, bvid: 'av170001' });
    expect(badBvid.body.success).toBe(false);
    const badRange = await request(appWithDb).post('/api/cache').send({ ...adBody, adTimeRanges: [[30, 10]] });
    expect(badRange.body.success).toBe(false);
  });

  it('POST /api/ai-script 保存并 GET 查回，非法分数拒绝', async () => {
    const save = await request(appWithDb).post('/api/ai-script').send({
      bvid: 'BV1aa411c7mD', aiScore: 87, criteriaVersion: 3, detectedAt: Date.now(),
    });
    expect(save.body.success).toBe(true);

    const query = await request(appWithDb).get('/api/ai-script/BV1aa411c7mD');
    expect(query.body.data.aiScore).toBe(87);
    expect(query.body.data.criteriaVersion).toBe(3);
    expect(query.body.data.version).toBe(1);

    for (const invalid of [-1, 101, 87.5, 'high']) {
      const bad = await request(appWithDb).post('/api/ai-script').send({ bvid: 'BV1aa411c7mD', aiScore: invalid });
      expect(bad.body.success).toBe(false);
    }
  });

  it('后提交的人工标注覆盖旧标注，模型写入不影响人工结果', async () => {
    const bvid = 'BV1bb411c7mD';
    const mark = (isAiScript: boolean) => request(appWithDb).post('/api/ai-script-label').send({ bvid, isAiScript });
    const read = () => request(appWithDb).get(`/api/ai-script/${bvid}`);

    expect((await mark(true)).body.success).toBe(true);
    expect((await read()).body).toMatchObject({ aiScriptLabel: true, data: null });
    expect((await mark(false)).body.success).toBe(true);
    expect((await request(appWithDb).post('/api/ai-script').send({ bvid, aiScore: 95 })).body.success).toBe(true);
    expect((await read()).body).toMatchObject({ aiScriptLabel: false, data: { aiScore: 95 } });

    const batch = await request(appWithDb).post('/api/batch').send({ bvids: [bvid] });
    expect(batch.body.data[bvid]).toMatchObject({ aiScriptLabel: false });
    const invalid = await request(appWithDb).post('/api/ai-script-label').send({ bvid, isAiScript: 'true' });
    expect(invalid.status).toBe(400);
    expect((await read()).body.aiScriptLabel).toBe(false);
  });

  it('模型评分和人工标注分别保存在各自的分 P', async () => {
    const bvid = 'BV1B7411L7tE';
    const p1 = '153700107';
    const p2 = '153700561';
    const score = (cid: string, page: number, aiScore: number) =>
      request(appWithDb).post('/api/ai-script/part').send({ bvid, cid, page, aiScore });
    const label = (cid: string, page: number, isAiScript: boolean) =>
      request(appWithDb).post('/api/ai-script-label/part').send({ bvid, cid, page, isAiScript });
    expect((await request(appWithDb).post('/api/ai-script-label').send({ bvid, isAiScript: true })).status).toBe(200);
    expect((await score(p1, 1, 80)).status).toBe(200);
    expect((await score(p2, 2, 20)).status).toBe(200);
    expect((await label(p2, 2, true)).status).toBe(200);
    expect((await label(p1, 1, true)).status).toBe(200);
    expect((await label(p1, 1, false)).status).toBe(200);

    const read = await request(appWithDb).get(`/api/ai-script/${bvid}?parts=1`);
    expect(read.body).toMatchObject({
      aiScriptLabel: true,
      parts: { [p1]: { aiScore: 80 }, [p2]: { aiScore: 20 } },
      aiScriptLabelParts: { [p1]: { isAiScript: false }, [p2]: { isAiScript: true } },
    });
    const batch = await request(appWithDb).post('/api/batch').send({ bvids: [bvid] });
    expect(batch.body.data[bvid]).toMatchObject({ aiScriptLabel: false, aiScript: { aiScore: 80 } });
  });

  it('POST /api/batch 一次返回两类数据并过滤 inaccurate 广告', async () => {
    const res = await request(appWithDb).post('/api/batch').send({
      bvids: [adBody.bvid, 'BV1aa411c7mD', 'BV1yy411c7mD'],
    });
    expect(res.body.success).toBe(true);
    expect(res.body.data[adBody.bvid].ad.goodName).toEqual(['商品甲']);
    expect(res.body.data['BV1aa411c7mD'].aiScript.aiScore).toBe(87);
    expect(res.body.data['BV1yy411c7mD'].ad).toBeNull(); // inaccurate 过滤
  });

  it('POST /api/batch 拒绝空数组、超量与非法条目', async () => {
    expect((await request(appWithDb).post('/api/batch').send({ bvids: [] })).body.success).toBe(false);
    expect((await request(appWithDb).post('/api/batch').send({ bvids: ['BV1xx411c7mD'.repeat(1), 'bad'] })).body.success).toBe(false);
    expect((await request(appWithDb).post('/api/batch').send({ bvids: Array(31).fill('BV1xx411c7mD') })).body.success).toBe(false);
  });

  it('未找到接口返回 404', async () => {
    const res = await request(appWithDb).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});
