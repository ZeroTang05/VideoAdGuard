/**
 * VideoAdGuard Cloudflare Worker - 云端广告缓存服务
 *
 * API:
 *   GET  /api/cache/:bvid    - 查询广告缓存（仅返回 accurate 记录）
 *   POST /api/cache          - 保存/更新广告缓存
 *   GET  /api/ai-script/:bvid - 查询 AI 文案检测结果
 *   POST /api/ai-script       - 保存/更新 AI 文案检测结果
 */

// ============= 类型定义 =============

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
        const record = JSON.parse(value) as AdRecord;
        if (record.accuracy === 'accurate') {
          return jsonResponse({ success: true, data: record, exists: true });
        }
        return jsonResponse({ success: true, data: null, exists: false });
      } catch {
        return errorResponse('缓存数据格式错误', 500);
      }
    }

    // POST /api/cache
    if (request.method === 'POST' && url.pathname === '/api/cache') {
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

      const validated = validateSaveBody(body);
      if (!validated) {
        return errorResponse('数据格式非法或字段超限', 400);
      }

      // 统一更新逻辑：用新数据覆盖已有记录的所有字段
      const existingValue = await env.VIDEO_AD_GUARD_KV.get(validated.bvid);
      let record: AdRecord;

      if (existingValue) {
        try {
          const existingRecord = JSON.parse(existingValue) as AdRecord;
          record = {
            ...existingRecord,
            exist: validated.exist,
            goodName: validated.goodName,
            adTimeRanges: validated.adTimeRanges,
            model: validated.model,
            provider: validated.provider,
            detectedAt: validated.detectedAt,
            isDetectionConfident: validated.isDetectionConfident,
            accuracy: validated.accuracy,
            source: validated.source,
          };
        } catch {
          // 解析失败，用新数据覆盖
          record = {
            bvid: validated.bvid,
            exist: validated.exist,
            goodName: validated.goodName,
            adTimeRanges: validated.adTimeRanges,
            model: validated.model,
            provider: validated.provider,
            detectedAt: validated.detectedAt,
            isDetectionConfident: validated.isDetectionConfident,
            accuracy: validated.accuracy,
            source: validated.source,
            version: DATA_VERSION,
            clientVersion: validated.clientVersion,
          };
        }
      } else {
        // 无旧记录，创建新记录
        record = {
          bvid: validated.bvid,
          exist: validated.exist,
          goodName: validated.goodName,
          adTimeRanges: validated.adTimeRanges,
          model: validated.model,
          provider: validated.provider,
          detectedAt: validated.detectedAt,
          isDetectionConfident: validated.isDetectionConfident,
          accuracy: validated.accuracy,
          source: validated.source,
          version: DATA_VERSION,
          clientVersion: validated.clientVersion,
        };
      }

      await env.VIDEO_AD_GUARD_KV.put(
        validated.bvid,
        JSON.stringify(record),
        getKvOptions(CACHE_TTL_SECONDS)
      );

      return jsonResponse({ success: true, data: { bvid: validated.bvid, accuracy: record.accuracy } });
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

      const value = await env.VIDEO_AD_GUARD_KV.get(AI_SCRIPT_KV_PREFIX + bvid);
      if (!value) {
        return jsonResponse({ success: true, data: null, exists: false });
      }

      try {
        const record = JSON.parse(value) as AiScriptRecord;
        return jsonResponse({ success: true, data: record, exists: true });
      } catch {
        return errorResponse('缓存数据格式错误', 500);
      }
    }

    // POST /api/ai-script
    if (request.method === 'POST' && url.pathname === '/api/ai-script') {
      const rateKey = `ai:save:${clientIP}`;
      if (!checkRateLimit(rateKey, RATE_LIMITS.saveAiScript)) {
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

      const validated = validateAiScriptBody(body);
      if (!validated) {
        return errorResponse('数据格式非法或字段超限', 400);
      }

      // 单视频单结果，直接覆盖存储
      const record: AiScriptRecord = {
        ...validated,
        version: DATA_VERSION,
      };

      await env.VIDEO_AD_GUARD_KV.put(
        AI_SCRIPT_KV_PREFIX + validated.bvid,
        JSON.stringify(record),
        getKvOptions(CACHE_TTL_SECONDS)
      );

      return jsonResponse({ success: true, data: { bvid: validated.bvid } });
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

      // 每个 bvid 读两条记录（广告 + AI 文案），并发读取
      const data: Record<string, { ad: AdRecord | null; aiScript: AiScriptRecord | null }> = {};
      await Promise.all(bvids.map(async (bvid) => {
        const [adValue, aiValue] = await Promise.all([
          env.VIDEO_AD_GUARD_KV.get(bvid),
          env.VIDEO_AD_GUARD_KV.get(AI_SCRIPT_KV_PREFIX + bvid),
        ]);

        let ad: AdRecord | null = null;
        if (adValue) {
          try {
            const record = JSON.parse(adValue) as AdRecord;
            // 与单条查询一致：inaccurate 记录不返回
            if (record.accuracy === 'accurate') ad = record;
          } catch { /* 损坏记录按无数据处理 */ }
        }

        let aiScript: AiScriptRecord | null = null;
        if (aiValue) {
          try {
            aiScript = JSON.parse(aiValue) as AiScriptRecord;
          } catch { /* 损坏记录按无数据处理 */ }
        }

        data[bvid] = { ad, aiScript };
      }));

      return jsonResponse({ success: true, data });
    }

    return errorResponse('未找到接口', 404);
  },
};