/**
 * VideoAdGuard 自建缓存服务：提供共享缓存及人工文案标注。
 * 部署在自己的服务器上作为第二后端（双写/兜底读），规避 Cloudflare 免费层限额。
 *
 * 路由：
 *   GET  /api/cache/:bvid    - 查询广告缓存（仅返回 accurate 记录）
 *   POST /api/cache          - 保存/更新广告缓存
 *   GET  /api/ai-script/:bvid - 查询 AI 感评分
 *   POST /api/ai-script       - 保存/更新 AI 感评分
 *   POST /api/ai-script-label - 保存/覆盖人工文案标注
 *   POST /api/batch           - 批量查询（首页卡片标注）
 *   GET  /                    - 健康检查（部署探活用）
 */

import express from 'express';
import { AI_SCRIPT_KV_PREFIX, countAiCommentReport, kvGet, kvPut, initDb, listSharedAiCommentUids } from './db';
import { maybeCleanupRateLimit, checkRateLimit, RATE_LIMITS } from './rateLimit';
import { AI_SCRIPT_LABEL_PREFIX, isValidCid, mergePartCache, PartCache, readLabelCache, selectVideoRecord } from './part-cache';
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
    const cache = JSON.parse(value) as PartCache<AdRecord>;
    const record = selectVideoRecord(cache);
    const data = record?.accuracy === 'accurate' ? record : null;
    return res.json({ success: true, data, exists: data !== null, parts: req.query.parts === '1' ? cache.parts : undefined });
  } catch {
    return errorResponse(res, '缓存数据格式错误', 500);
  }
});

// POST /api/cache：与 Worker 一致，已有记录合并覆盖
app.post(['/api/cache', '/api/cache/part'], (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`save:${req.ip}`, RATE_LIMITS.saveCache)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const cid: unknown = req.path.endsWith('/part') ? req.body?.cid : undefined;
  const validated = validateSaveBody(req.body ?? {});
  if (!validated || (req.path.endsWith('/part') && !isValidCid(cid))) {
    return errorResponse(res, '数据格式非法或字段超限', 400);
  }

  const existingValue = kvGet(validated.bvid);
  const cache = mergePartCache<AdRecord>(
    existingValue === null ? {} : JSON.parse(existingValue),
    { ...validated, version: DATA_VERSION },
    isValidCid(cid) ? cid : undefined,
    req.body.page === 1,
  );
  kvPut(validated.bvid, JSON.stringify(cache));
  res.json({ success: true, data: { bvid: validated.bvid, cid, accuracy: validated.accuracy } });
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

  try {
    const value = kvGet(AI_SCRIPT_KV_PREFIX + bvid);
    const cache: PartCache<AiScriptRecord> = value === null ? {} : JSON.parse(value);
    const labels = readLabelCache(kvGet(AI_SCRIPT_LABEL_PREFIX + bvid));
    const data = selectVideoRecord(cache);
    const includeParts = req.query.parts === '1';
    return res.json({
      success: true, data, exists: data !== null, aiScriptLabel: labels.isAiScript,
      parts: includeParts ? cache.parts : undefined,
      aiScriptLabelParts: includeParts ? labels.parts : undefined,
    });
  } catch {
    return errorResponse(res, '缓存数据格式错误', 500);
  }
});

// POST /api/ai-script：旧客户端写整条，新客户端更新当前分 P。
app.post(['/api/ai-script', '/api/ai-script/part'], (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`ai:save:${req.ip}`, RATE_LIMITS.saveAiScript)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const cid: unknown = req.path.endsWith('/part') ? req.body?.cid : undefined;
  const validated = validateAiScriptBody(req.body ?? {});
  if (!validated || (req.path.endsWith('/part') && !isValidCid(cid))) {
    return errorResponse(res, '数据格式非法或字段超限', 400);
  }

  const key = AI_SCRIPT_KV_PREFIX + validated.bvid;
  const value = kvGet(key);
  const cache = mergePartCache<AiScriptRecord>(
    value === null ? {} : JSON.parse(value),
    { ...validated, version: DATA_VERSION },
    isValidCid(cid) ? cid : undefined,
    req.body.page === 1,
  );
  kvPut(key, JSON.stringify(cache));
  res.json({ success: true, data: { bvid: validated.bvid, cid } });
});

// 每个分 P 只保留最后一次成功写入的人工标注。
app.post(['/api/ai-script-label', '/api/ai-script-label/part'], (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`ai:label:${req.ip}`, RATE_LIMITS.saveAiScript)) {
    return errorResponse(res, '请求过于频繁', 429);
  }

  const { bvid, isAiScript, page } = req.body ?? {};
  const cid: unknown = req.path.endsWith('/part') ? req.body?.cid : undefined;
  if (!isValidBvid(bvid) || typeof isAiScript !== 'boolean' || (req.path.endsWith('/part') && !isValidCid(cid))) {
    return errorResponse(res, '标注数据格式错误', 400);
  }

  const key = AI_SCRIPT_LABEL_PREFIX + bvid;
  const cache = mergePartCache(readLabelCache(kvGet(key)), { isAiScript }, isValidCid(cid) ? cid : undefined, page === 1);
  kvPut(key, JSON.stringify(cache.parts ? cache : isAiScript));
  res.json({ success: true, data: { bvid, cid, isAiScript } });
});

// 客户端只下载已发布名单，同一个 UID 的每次有效 POST 都独立计数。
app.get('/api/ai-comment-blocklist', (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`ai-comment:get:${req.ip}`, RATE_LIMITS.getAiCommentBlocklist)) {
    return errorResponse(res, '请求过于频繁', 429);
  }
  res.json({ success: true, data: { uids: listSharedAiCommentUids() } });
});

app.post('/api/ai-comment-blocklist', (req, res) => {
  maybeCleanupRateLimit();
  if (!checkRateLimit(`ai-comment:save:${req.ip}`, RATE_LIMITS.saveAiCommentBlocklist)) {
    return errorResponse(res, '请求过于频繁', 429);
  }
  const uid: unknown = req.body?.uid;
  if (typeof uid !== 'string' || !/^[1-9]\d{0,19}$/.test(uid)) {
    return errorResponse(res, '无效的评论者 UID');
  }
  res.json({ success: true, data: { uid, ...countAiCommentReport(uid) } });
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

  const data: Record<string, { ad: AdRecord | null; aiScript: AiScriptRecord | null; aiScriptLabel?: boolean }> = {};
  for (const bvid of bvids) {
    let ad: AdRecord | null = null;
    const adValue = kvGet(bvid);
    if (adValue) {
      try {
        const record = selectVideoRecord(JSON.parse(adValue) as PartCache<AdRecord>, true);
        if (record?.accuracy === 'accurate') ad = record;
      } catch {
        // 损坏记录按无数据处理
      }
    }

    let aiScript: AiScriptRecord | null = null;
    const aiValue = kvGet(AI_SCRIPT_KV_PREFIX + bvid);
    if (aiValue) {
      try {
        aiScript = selectVideoRecord(JSON.parse(aiValue) as PartCache<AiScriptRecord>, true);
      } catch {
        // 损坏记录按无数据处理
      }
    }

    const labels = readLabelCache(kvGet(AI_SCRIPT_LABEL_PREFIX + bvid));
    const firstLabel = labels.firstCid ? labels.parts?.[labels.firstCid]?.isAiScript : undefined;
    data[bvid] = { ad, aiScript, aiScriptLabel: firstLabel ?? labels.isAiScript };
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
