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
