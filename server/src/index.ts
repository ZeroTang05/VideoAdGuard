/**
 * VideoAdGuard 自建缓存服务：API 与 Cloudflare Worker 版完全对齐。
 * 部署在自己的服务器上作为第二后端（双写/兜底读），规避 Cloudflare 免费层限额。
 *
 * 路由：
 *   GET  /api/cache/:bvid    - 查询广告缓存（仅返回 accurate 记录）
 *   POST /api/cache          - 保存/更新广告缓存
 *   GET  /api/ai-script/:bvid - 查询 AI 感评分
 *   POST /api/ai-script       - 保存/更新 AI 感评分
 *   POST /api/batch           - 批量查询（首页卡片标注）
 *   GET  /                    - 健康检查（部署探活用）
 */

import express from 'express';
import { AI_SCRIPT_KV_PREFIX, kvGet, kvPut, initDb } from './db';
import { maybeCleanupRateLimit, checkRateLimit, RATE_LIMITS } from './rateLimit';
import {
  AdRecord,
  AiScriptRecord,
  DATA_VERSION,
  MAX_BATCH_BVIDS,
  MAX_BODY_SIZE,
  isValidBvid,
  validateAiScriptBody,
  validateSaveBody,
} from './validate';

const app = express();
const PORT = Number(process.env.PORT) || 8787;
const BIND_ADDRESS = process.env.CACHE_BIND_ADDRESS || undefined;

// JSON 解析与体积限制（与 Worker 的 content-length 检查一致）
app.use(express.json({ limit: MAX_BODY_SIZE }));

// CORS：客户端走 background 请求不受 CORS 约束，但保持与 Worker 相同的响应头
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-Version',
  });
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function errorResponse(res: express.Response, message: string, status = 400): void {
  res.status(status).json({ success: false, error: message });
}

// 健康检查
app.get('/', (_req, res) => {
  res.json({ success: true, data: { service: 'videoadguard-cache-server', version: DATA_VERSION } });
});

// GET /api/cache/:bvid
app.get('/api/cache/:bvid', (req, res) => {
  maybeCleanupRateLimit();
  const { bvid } = req.params;
  if (!isValidBvid(bvid)) {
    return errorResponse(res, '无效的 BV 号格式', 400);
  }
  if (!checkRateLimit(`get:${req.ip}`, RATE_LIMITS.getCache)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const value = kvGet(bvid);
  if (!value) {
    return res.json({ success: true, data: null, exists: false });
  }
  try {
    const record = JSON.parse(value) as AdRecord;
    if (record.accuracy === 'accurate') {
      return res.json({ success: true, data: record, exists: true });
    }
    return res.json({ success: true, data: null, exists: false });
  } catch {
    return errorResponse(res, '缓存数据格式错误', 500);
  }
});

// POST /api/cache：与 Worker 一致，已有记录合并覆盖
app.post('/api/cache', (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`save:${req.ip}`, RATE_LIMITS.saveCache)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const validated = validateSaveBody(req.body as Record<string, unknown>);
  if (!validated) {
    return errorResponse(res, '数据格式非法或字段超限', 400);
  }

  const existingValue = kvGet(validated.bvid);
  let record: AdRecord;
  if (existingValue) {
    try {
      const existingRecord = JSON.parse(existingValue) as AdRecord;
      record = { ...existingRecord, ...validated };
    } catch {
      record = { ...validated, version: DATA_VERSION };
    }
  } else {
    record = { ...validated, version: DATA_VERSION };
  }

  kvPut(validated.bvid, JSON.stringify(record));
  res.json({ success: true, data: { bvid: validated.bvid, accuracy: record.accuracy } });
});

// GET /api/ai-script/:bvid
app.get('/api/ai-script/:bvid', (req, res) => {
  maybeCleanupRateLimit();
  const { bvid } = req.params;
  if (!isValidBvid(bvid)) {
    return errorResponse(res, '无效的 BV 号格式', 400);
  }
  if (!checkRateLimit(`ai:get:${req.ip}`, RATE_LIMITS.getAiScript)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const value = kvGet(AI_SCRIPT_KV_PREFIX + bvid);
  if (!value) {
    return res.json({ success: true, data: null, exists: false });
  }
  try {
    return res.json({ success: true, data: JSON.parse(value) as AiScriptRecord, exists: true });
  } catch {
    return errorResponse(res, '缓存数据格式错误', 500);
  }
});

// POST /api/ai-script：单视频单结果，直接覆盖
app.post('/api/ai-script', (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`ai:save:${req.ip}`, RATE_LIMITS.saveAiScript)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const validated = validateAiScriptBody(req.body as Record<string, unknown>);
  if (!validated) {
    return errorResponse(res, '数据格式非法或字段超限', 400);
  }

  const record: AiScriptRecord = { ...validated, version: DATA_VERSION };
  kvPut(AI_SCRIPT_KV_PREFIX + validated.bvid, JSON.stringify(record));
  res.json({ success: true, data: { bvid: validated.bvid } });
});

// POST /api/batch：批量查询广告与 AI 感评分（首页卡片标注用）
app.post('/api/batch', (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`batch:${req.ip}`, RATE_LIMITS.getBatch)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const rawBvids = (req.body as Record<string, unknown>)?.bvids;
  if (!Array.isArray(rawBvids) || rawBvids.length === 0 || rawBvids.length > MAX_BATCH_BVIDS) {
    return errorResponse(res, `bvids 必须是 1~${MAX_BATCH_BVIDS} 个 BV 号数组`, 400);
  }

  const bvids = [...new Set(rawBvids)] as string[];
  if (bvids.some((bvid) => !isValidBvid(bvid))) {
    return errorResponse(res, '包含非法的 BV 号', 400);
  }

  const data: Record<string, { ad: AdRecord | null; aiScript: AiScriptRecord | null }> = {};
  for (const bvid of bvids) {
    let ad: AdRecord | null = null;
    const adValue = kvGet(bvid);
    if (adValue) {
      try {
        const record = JSON.parse(adValue) as AdRecord;
        if (record.accuracy === 'accurate') ad = record;
      } catch {
        // 损坏记录按无数据处理
      }
    }

    let aiScript: AiScriptRecord | null = null;
    const aiValue = kvGet(AI_SCRIPT_KV_PREFIX + bvid);
    if (aiValue) {
      try {
        aiScript = JSON.parse(aiValue) as AiScriptRecord;
      } catch {
        // 损坏记录按无数据处理
      }
    }

    data[bvid] = { ad, aiScript };
  }

  res.json({ success: true, data });
});

// 404 兜底
app.use((_req, res) => {
  errorResponse(res, '未找到接口', 404);
});

// 启动（被 import 时不自动监听，便于测试）
if (require.main === module) {
  initDb();
  app.listen({ port: PORT, host: BIND_ADDRESS }, () => {
    console.log(`【VideoAdGuard】自建缓存服务已启动: http://${BIND_ADDRESS || '0.0.0.0'}:${PORT}`);
  });
}

export { app, initDb };
