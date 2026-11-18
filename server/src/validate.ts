/**
 * 数据验证逻辑：与 worker/src/index.ts 的验证语义保持一致（KV 键、字段白名单、区间检查）。
 * 两个部署单元（Cloudflare Worker / 自建服务器）需同步修改，保持 API 行为一致。
 */

export interface AdRecord {
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

export const DATA_VERSION = 1;

export const MAX_BODY_SIZE = 10 * 1024;
export const MAX_AD_RANGES = 50;
export const MAX_GOOD_NAMES = 100;
export const MAX_TIME_VALUE = 86400;
export const MAX_STRING_LENGTH = 100;
export const MAX_FUTURE_MS = 86400000; // 允许的最大未来时间（1天）
export const MAX_BATCH_BVIDS = 30;

export function isValidBvid(bvid: string): boolean {
  return typeof bvid === 'string' && /^BV1[0-9A-Za-z]{8,}$/.test(bvid);
}

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

export interface ValidatedSaveData {
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

export function validateSaveBody(body: Record<string, unknown>): ValidatedSaveData | null {
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

  const model = typeof body.model === 'string' ? body.model.slice(0, MAX_STRING_LENGTH) : 'unknown';
  const provider = typeof body.provider === 'string' ? body.provider.slice(0, MAX_STRING_LENGTH) : 'unknown';

  const detectedAt = typeof body.detectedAt === 'number' ? body.detectedAt : Date.now();
  if (detectedAt < 0 || detectedAt > Date.now() + MAX_FUTURE_MS) {
    return null;
  }

  const clientVersion = typeof body.clientVersion === 'string' ? body.clientVersion.slice(0, MAX_STRING_LENGTH) : '';

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

export interface ValidatedAiScriptData {
  bvid: string;
  aiScore: number;
  criteriaVersion?: number;
  model: string;
  provider: string;
  detectedAt: number;
  clientVersion: string;
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

  const criteriaVersion =
    typeof body.criteriaVersion === 'number' && Number.isInteger(body.criteriaVersion) && body.criteriaVersion > 0
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
