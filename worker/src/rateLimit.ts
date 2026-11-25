/**
 * Rate Limiting Module
 * Provides rate limiting functionality for Worker endpoints
 */

export interface RateLimitConfig {
  windowMs: number;
  max: number;
}

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export const RATE_LIMIT_CLEANUP_INTERVAL = 100;
export const RATE_LIMIT_CLEANUP_WINDOW = 60_000;

export const RATE_LIMITS: Record<'getCache' | 'saveCache' | 'getAiScript' | 'saveAiScript' | 'getBatch' | 'getAiCommentBlocklist' | 'saveAiCommentBlocklist', RateLimitConfig> = {
  getCache: { windowMs: 1000, max: 2 },
  saveCache: { windowMs: 60_000, max: 10 },
  getAiScript: { windowMs: 1000, max: 2 },
  saveAiScript: { windowMs: 60_000, max: 10 },
  getBatch: { windowMs: 1000, max: 2 },
  getAiCommentBlocklist: { windowMs: 10_000, max: 2 },
  saveAiCommentBlocklist: { windowMs: 60_000, max: 20 },
};

// In-memory store for rate limiting
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

  entry.count++;
  return true;
}

export function cleanupExpiredRateLimitEntries(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt && now > entry.resetAt + RATE_LIMIT_CLEANUP_WINDOW) {
      rateLimitStore.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`[RateLimit] 清理了 ${cleaned} 个过期条目，剩余 ${rateLimitStore.size}`);
  }
}

export function maybeCleanupRateLimit(): void {
  requestCount++;
  if (requestCount % RATE_LIMIT_CLEANUP_INTERVAL === 0) {
    cleanupExpiredRateLimitEntries();
  }
}

export function resetRateLimitStore(): void {
  rateLimitStore.clear();
  requestCount = 0;
}

export function getRateLimitStore(): Map<string, RateLimitEntry> {
  return rateLimitStore;
}

export function getRequestCount(): number {
  return requestCount;
}
