/**
 * VideoAdGuard Cloudflare Worker - 云端广告缓存服务
 *
 * API:
 *   GET  /api/cache/:bvid    - 查询广告缓存（仅返回 accurate 记录）
 *   POST /api/cache          - 保存/更新广告缓存
 *   GET  /api/ai-script/:bvid - 查询 AI 文案检测结果
 *   POST /api/ai-script       - 保存/更新 AI 文案检测结果
 */

import { AI_SCRIPT_LABEL_PREFIX, isValidCid, mergePartCache, PartCache, readLabelCache, selectVideoRecord } from '../../server/src/part-cache';
import { countCommentReport, isValidCommentUid, listSharedCommentUids } from './ai-comment-blocklist';

export interface Env {
  VIDEO_AD_GUARD_KV: KVNamespace;
}

interface AdRecord {
  bvid: string;
  exist: boolean;
  goodName: string[];
  adTimeRanges: number[][];
  model: string;
  provider: string;
  detectedAt: number;
  isDetectionConfident: boolean;
  accuracy: 'accurate' | 'inaccurate';
  source: 'ai' | 'user';
  version: number;
  clientVersion: string;
}

/** AI 感评分记录（KV 键：ai:bvid） */
export interface AiScriptRecord {
  bvid: string;
  /** AI 感分数，0~100 整数 */
  aiScore: number;
  /** 评分标准版本（可选，旧记录缺省视为 1） */
  criteriaVersion?: number;
  model: string;
  provider: string;
  detectedAt: number;
  version: number;
  clientVersion: string;
}

export interface ValidatedAiScriptData {
  bvid: string;
  aiScore: number;
  criteriaVersion?: number;
  model: string;
  provider: string;
  detectedAt: number;
  clientVersion: string;
}

interface ValidatedSaveData {
  bvid: string;
  exist: boolean;
  goodName: string[];
  adTimeRanges: number[][];
  model: string;
  provider: string;
  detectedAt: number;
  isDetectionConfident: boolean;
  accuracy: 'accurate' | 'inaccurate';
  source: 'ai' | 'user';
  clientVersion: string;
}

// ============= 常量 =============

const DATA_VERSION = 1;
const CACHE_TTL_SECONDS = 0;

const MAX_BODY_SIZE = 10 * 1024;
const MAX_AD_RANGES = 50;
const MAX_GOOD_NAMES = 100;
const MAX_TIME_VALUE = 86400;
const MAX_STRING_LENGTH = 100;
const MAX_FUTURE_MS = 86400000; // 允许的最大未来时间（1天）

// AI 文案检测的 KV 键前缀，与广告记录分开存储
const AI_SCRIPT_KV_PREFIX = 'ai:';
// 批量查询的单次上限
const MAX_BATCH_BVIDS = 30;

// ============= 导入 rate limit 模块 =============
import {
  RATE_LIMITS,
  checkRateLimit,
  maybeCleanupRateLimit,
} from './rateLimit';

// ============= 工具函数 =============

function getKvOptions(ttl: number): { expirationTtl: number } | undefined {
  return ttl > 0 ? { expirationTtl: ttl } : undefined;
}

function isValidBvid(bvid: string): boolean {
  return typeof bvid === 'string' && /^BV1[0-9A-Za-z]{8,}$/.test(bvid);
}

// ============= 数据验证 =============

function validateAdTimeRanges(ranges: unknown): number[][] | null {
  if (!Array.isArray(ranges) || ranges.length > MAX_AD_RANGES) {
    return null;
  }

  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) {
      return null;
    }
    const [start, end] = range;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }
    if (start < 0 || end < 0 || start > MAX_TIME_VALUE || end > MAX_TIME_VALUE) {
      return null;
    }
    if (start >= end) {
      return null;
    }
  }

  return ranges as number[][];
}

function validateGoodNames(names: unknown): string[] | null {
  if (!Array.isArray(names) || names.length > MAX_GOOD_NAMES) {
    return null;
  }

  for (const name of names) {
    if (typeof name !== 'string' || name.length > MAX_STRING_LENGTH) {
      return null;
    }
  }

  return names as string[];
}

function validateSaveBody(body: Record<string, unknown>): ValidatedSaveData | null {
  const bvid = typeof body.bvid === 'string' ? body.bvid : '';
  if (!isValidBvid(bvid)) {
    return null;
  }

  const goodName = validateGoodNames(body.goodName);
  if (goodName === null) {
    return null;
  }

  const adTimeRanges = validateAdTimeRanges(body.adTimeRanges);
  if (adTimeRanges === null) {
    return null;
  }

  const model = typeof body.model === 'string'
    ? body.model.slice(0, MAX_STRING_LENGTH)
    : 'unknown';
  const provider = typeof body.provider === 'string'
    ? body.provider.slice(0, MAX_STRING_LENGTH)
    : 'unknown';

  const detectedAt = typeof body.detectedAt === 'number' ? body.detectedAt : Date.now();
  if (detectedAt < 0 || detectedAt > Date.now() + MAX_FUTURE_MS) {
    return null;
  }

  const clientVersion = typeof body.clientVersion === 'string'
    ? body.clientVersion.slice(0, MAX_STRING_LENGTH)
    : '';

  return {
    bvid,
    exist: body.exist === true,
    goodName,
    adTimeRanges,
    model,
    provider,
    detectedAt,
    isDetectionConfident: body.isDetectionConfident === true,
    accuracy: body.accuracy === 'inaccurate' ? 'inaccurate' : 'accurate',
    source: body.source === 'user' ? 'user' : 'ai',
    clientVersion,
  };
}

/** 验证 AI 感评分保存请求；aiScore 必须是 0~100 的整数 */
export function validateAiScriptBody(body: Record<string, unknown>): ValidatedAiScriptData | null {
  const bvid = typeof body.bvid === 'string' ? body.bvid : '';
  if (!isValidBvid(bvid)) {
    return null;
  }

  const aiScore = body.aiScore;
  if (typeof aiScore !== 'number' || !Number.isInteger(aiScore) || aiScore < 0 || aiScore > 100) {
    return null;
  }

  const detectedAt = typeof body.detectedAt === 'number' ? body.detectedAt : Date.now();
  if (detectedAt < 0 || detectedAt > Date.now() + MAX_FUTURE_MS) {
    return null;
  }

  const criteriaVersion = typeof body.criteriaVersion === 'number' && Number.isInteger(body.criteriaVersion) && body.criteriaVersion > 0
    ? body.criteriaVersion
    : undefined;

  return {
    bvid,
    aiScore,
    criteriaVersion,
    model: typeof body.model === 'string' ? body.model.slice(0, MAX_STRING_LENGTH) : 'unknown',
    provider: typeof body.provider === 'string' ? body.provider.slice(0, MAX_STRING_LENGTH) : 'unknown',
    detectedAt,
    clientVersion: typeof body.clientVersion === 'string' ? body.clientVersion.slice(0, MAX_STRING_LENGTH) : '',
  };
}

// ============= 响应构建 =============

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Client-Version',
      ...extraHeaders,
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ success: false, error: message }, status);
}

// ============= 请求处理 =============

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    maybeCleanupRateLimit();

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Client-Version',
        },
      });
    }

    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP') ?? 'unknown';

    if (request.method === 'GET' && url.pathname === '/api/ai-comment-blocklist') {
      if (!checkRateLimit(`ai-comment:get:${clientIP}`, RATE_LIMITS.getAiCommentBlocklist)) {
        return errorResponse('请求过于频繁', 429);
      }
      const uids = await listSharedCommentUids(env.VIDEO_AD_GUARD_KV);
      return jsonResponse({ success: true, data: { uids } });
    }

    if (request.method === 'POST' && url.pathname === '/api/ai-comment-blocklist') {
      if (!checkRateLimit(`ai-comment:save:${clientIP}`, RATE_LIMITS.saveAiCommentBlocklist)) {
        return errorResponse('请求过于频繁', 429);
      }
      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return errorResponse('请求体过大', 400);
      }
      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return errorResponse('请求体必须是 JSON', 400);
      }
      const uid = body.uid;
      if (!isValidCommentUid(uid)) return errorResponse('无效的评论者 UID', 400);
      const result = await countCommentReport(env.VIDEO_AD_GUARD_KV, uid);
      return jsonResponse({ success: true, data: { uid, ...result } });
    }

    // GET /api/cache/:bvid
    const cacheMatch = url.pathname.match(/^\/api\/cache\/(?<bvid>.+)$/);
    if (request.method === 'GET' && cacheMatch?.groups?.bvid) {
      const bvid = cacheMatch.groups.bvid;

      if (!isValidBvid(bvid)) {
        return errorResponse('无效的 BV 号格式', 400);
      }

      const rateKey = `get:${clientIP}`;
      if (!checkRateLimit(rateKey, RATE_LIMITS.getCache)) {
        return errorResponse('请求过于频繁', 429);
      }

      const value = await env.VIDEO_AD_GUARD_KV.get(bvid);
      if (!value) {
        return jsonResponse({ success: true, data: null, exists: false });
      }

      try {
        const cache = JSON.parse(value) as PartCache<AdRecord>;
        const record = selectVideoRecord(cache);
        const data = record?.accuracy === 'accurate' ? record : null;
        return jsonResponse({
          success: true, data, exists: data !== null,
          parts: url.searchParams.get('parts') === '1' ? cache.parts : undefined,
        });
      } catch {
        return errorResponse('缓存数据格式错误', 500);
      }
    }

    // POST /api/cache
    if (request.method === 'POST' && ['/api/cache', '/api/cache/part'].includes(url.pathname)) {
      const rateKey = `save:${clientIP}`;
      if (!checkRateLimit(rateKey, RATE_LIMITS.saveCache)) {
        return errorResponse('请求过于频繁', 429);
      }

      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return errorResponse('请求体过大', 400);
      }

      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return errorResponse('请求体必须是 JSON', 400);
      }

      const cid = url.pathname.endsWith('/part') ? body?.cid : undefined;
      const validated = validateSaveBody(body ?? {});
      if (!validated || (url.pathname.endsWith('/part') && !isValidCid(cid))) {
        return errorResponse('数据格式非法或字段超限', 400);
      }

      const existingValue = await env.VIDEO_AD_GUARD_KV.get(validated.bvid);
      const cache = mergePartCache<AdRecord>(
        existingValue === null ? {} : JSON.parse(existingValue),
        { ...validated, version: DATA_VERSION },
        isValidCid(cid) ? cid : undefined,
        body.page === 1,
      );
      await env.VIDEO_AD_GUARD_KV.put(
        validated.bvid,
        JSON.stringify(cache),
        getKvOptions(CACHE_TTL_SECONDS)
      );

      return jsonResponse({ success: true, data: { bvid: validated.bvid, cid, accuracy: validated.accuracy } });
    }

    // GET /api/ai-script/:bvid
    const aiScriptMatch = url.pathname.match(/^\/api\/ai-script\/(?<bvid>.+)$/);
    if (request.method === 'GET' && aiScriptMatch?.groups?.bvid) {
      const bvid = aiScriptMatch.groups.bvid;

      if (!isValidBvid(bvid)) {
        return errorResponse('无效的 BV 号格式', 400);
      }

      const rateKey = `ai:get:${clientIP}`;
      if (!checkRateLimit(rateKey, RATE_LIMITS.getAiScript)) {
        return errorResponse('请求过于频繁', 429);
      }

      try {
        const [value, labelValue] = await Promise.all([
          env.VIDEO_AD_GUARD_KV.get(AI_SCRIPT_KV_PREFIX + bvid),
          env.VIDEO_AD_GUARD_KV.get(AI_SCRIPT_LABEL_PREFIX + bvid),
        ]);
        const cache: PartCache<AiScriptRecord> = value === null ? {} : JSON.parse(value);
        const labels = readLabelCache(labelValue);
        const data = selectVideoRecord(cache);
        const includeParts = url.searchParams.get('parts') === '1';
        return jsonResponse({
          success: true, data, exists: data !== null, aiScriptLabel: labels.isAiScript,
          parts: includeParts ? cache.parts : undefined,
          aiScriptLabelParts: includeParts ? labels.parts : undefined,
        });
      } catch {
        return errorResponse('缓存数据格式错误', 500);
      }
    }

    // POST /api/ai-script
    if (request.method === 'POST' && [
      '/api/ai-script', '/api/ai-script/part', '/api/ai-script-label', '/api/ai-script-label/part',
    ].includes(url.pathname)) {
      const isLabel = url.pathname.startsWith('/api/ai-script-label');
      const rateKey = `ai:save:${clientIP}`;
      if (!checkRateLimit(isLabel ? `ai:label:${clientIP}` : rateKey, RATE_LIMITS.saveAiScript)) {
        return errorResponse('请求过于频繁', 429);
      }

      const contentLength = request.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return errorResponse('请求体过大', 400);
      }

      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return errorResponse('请求体必须是 JSON', 400);
      }

      const cid = url.pathname.endsWith('/part') ? body?.cid : undefined;
      if (url.pathname.endsWith('/part') && !isValidCid(cid)) {
        return errorResponse('数据格式非法或字段超限', 400);
      }
      const partCid = isValidCid(cid) ? cid : undefined;
      if (isLabel) {
        const { bvid, isAiScript, page } = body ?? {};
        if (!isValidBvid(bvid) || typeof isAiScript !== 'boolean') {
          return errorResponse('标注数据格式错误', 400);
        }
        const key = AI_SCRIPT_LABEL_PREFIX + bvid;
        const labels = readLabelCache(await env.VIDEO_AD_GUARD_KV.get(key));
        const cache = mergePartCache(labels, { isAiScript }, partCid, page === 1);
        await env.VIDEO_AD_GUARD_KV.put(key, JSON.stringify(cache.parts ? cache : isAiScript));
        return jsonResponse({ success: true, data: { bvid, cid, isAiScript } });
      }

      const validated = validateAiScriptBody(body ?? {});
      if (!validated) return errorResponse('数据格式非法或字段超限', 400);
      const key = AI_SCRIPT_KV_PREFIX + validated.bvid;
      const value = await env.VIDEO_AD_GUARD_KV.get(key);
      const cache = mergePartCache<AiScriptRecord>(
        value === null ? {} : JSON.parse(value),
        { ...validated, version: DATA_VERSION },
        partCid,
        body.page === 1,
      );

      await env.VIDEO_AD_GUARD_KV.put(
        key,
        JSON.stringify(cache),
        getKvOptions(CACHE_TTL_SECONDS)
      );

      return jsonResponse({ success: true, data: { bvid: validated.bvid, cid } });
    }

    // POST /api/batch - 批量查询广告与 AI 文案检测结果（首页卡片标注用）
    if (request.method === 'POST' && url.pathname === '/api/batch') {
      const rateKey = `batch:${clientIP}`;
      if (!checkRateLimit(rateKey, RATE_LIMITS.getBatch)) {
        return errorResponse('请求过于频繁', 429);
      }

      let body: Record<string, unknown>;
      try {
        body = await request.json() as Record<string, unknown>;
      } catch {
        return errorResponse('请求体必须是 JSON', 400);
      }

      const rawBvids = body.bvids;
      if (!Array.isArray(rawBvids) || rawBvids.length === 0 || rawBvids.length > MAX_BATCH_BVIDS) {
        return errorResponse(`bvids 必须是 1~${MAX_BATCH_BVIDS} 个 BV 号数组`, 400);
      }

      // 去重并校验，非法条目直接拒绝
      const bvids = [...new Set(rawBvids as unknown[])] as string[];
      if (bvids.some((bvid) => !isValidBvid(bvid))) {
        return errorResponse('包含非法的 BV 号', 400);
      }

      const data: Record<string, { ad: AdRecord | null; aiScript: AiScriptRecord | null; aiScriptLabel?: boolean }> = {};
      await Promise.all(bvids.map(async (bvid) => {
        const [adValue, aiValue, labelValue] = await Promise.all([
          env.VIDEO_AD_GUARD_KV.get(bvid),
          env.VIDEO_AD_GUARD_KV.get(AI_SCRIPT_KV_PREFIX + bvid),
          env.VIDEO_AD_GUARD_KV.get(AI_SCRIPT_LABEL_PREFIX + bvid),
        ]);

        let ad: AdRecord | null = null;
        if (adValue) {
          try {
            const record = selectVideoRecord(JSON.parse(adValue) as PartCache<AdRecord>, true);
            if (record?.accuracy === 'accurate') ad = record;
          } catch { /* 损坏记录按无数据处理 */ }
        }

        let aiScript: AiScriptRecord | null = null;
        if (aiValue) {
          try {
            aiScript = selectVideoRecord(JSON.parse(aiValue) as PartCache<AiScriptRecord>, true);
          } catch { /* 损坏记录按无数据处理 */ }
        }

        const labels = readLabelCache(labelValue);
        const firstLabel = labels.firstCid ? labels.parts?.[labels.firstCid]?.isAiScript : undefined;
        data[bvid] = { ad, aiScript, aiScriptLabel: firstLabel ?? labels.isAiScript };
      }));

      return jsonResponse({ success: true, data });
    }

    return errorResponse('未找到接口', 404);
  },
};
