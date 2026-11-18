/**
 * 内存限流：与 worker/src/rateLimit.ts 语义一致（按 IP+端点分桶）。
 * 两个部署单元需同步修改。自建服务器重启即清零，与 Cloudflare 版行为相同。
 */

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  getCache: { windowMs: 1000, max: 2 },
  saveCache: { windowMs: 60_000, max: 10 },
  getAiScript: { windowMs: 1000, max: 2 },
  saveAiScript: { windowMs: 60_000, max: 10 },
  getBatch: { windowMs: 1000, max: 2 },
};

const RATE_LIMIT_CLEANUP_INTERVAL = 100;
const RATE_LIMIT_CLEANUP_WINDOW = 60_000;

const rateLimitStore = new Map<string, RateLimitEntry>();
let requestCount = 0;

export function checkRateLimit(key: string, limit: RateLimitConfig): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }

  if (entry.count >= limit.max) {
    return false;
  }

  entry.count += 1;
  return true;
}

/** 定期清理过期桶，防止内存增长（与 Cloudflare 版相同的计数策略） */
export function maybeCleanupRateLimit(): void {
  requestCount += 1;
  if (requestCount % RATE_LIMIT_CLEANUP_INTERVAL !== 0) return;

  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}
