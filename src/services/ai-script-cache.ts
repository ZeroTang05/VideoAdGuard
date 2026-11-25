/**
 * AI 感评分结果的本地缓存。
 * 与广告检测缓存分开存储：数据结构不同、互不覆盖。
 */

import { AI_SCRIPT_CRITERIA_VERSION } from './prompt';
import type { VideoPart } from './bilibili';

export interface AiScriptCacheItem {
  /** AI 感分数，0~100 整数 */
  aiScore: number;
  /** 评分标准版本，标准换版后旧记录自动失效 */
  criteriaVersion: number;
  model: string;
  provider: string;
  /** 检测时间戳 */
  detectedAt: number;
  source: 'local' | 'remote';
  /** 创建时间戳，用于过期判断 */
  createdAt: number;
}

type AiScriptCacheValue = Partial<AiScriptCacheItem> & { parts?: Record<string, AiScriptCacheItem> };

export class AiScriptCacheService {
  private static readonly CACHE_KEY = 'videoAdGuard_aiScriptCache';
  private static readonly CACHE_EXPIRY_DAYS = 1; // 与广告缓存一致：1 天过期
  private static readonly CACHE_EXPIRY_MS = AiScriptCacheService.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  private static manualLabelKey({ bvid, cid }: VideoPart): string {
    return `aiScriptLabel:${bvid}:${cid}`;
  }

  /** 人工标注按分 P 单独保存，不随评分缓存过期。 */
  public static async getManualLabel(part: VideoPart): Promise<boolean | undefined> {
    const key = this.manualLabelKey(part);
    const value = (await chrome.storage.local.get(key))[key];
    return typeof value === 'boolean' ? value : undefined;
  }

  public static saveManualLabel(part: VideoPart, isAiScript: boolean): Promise<void> {
    return chrome.storage.local.set({ [this.manualLabelKey(part)]: isAiScript });
  }

  private static async getAll(): Promise<Record<string, AiScriptCacheValue>> {
    try {
      const result = await chrome.storage.local.get(AiScriptCacheService.CACHE_KEY);
      return result[AiScriptCacheService.CACHE_KEY] || {};
    } catch (error) {
      console.warn('【VideoAdGuard】[AiScriptCache] 获取缓存失败:', error);
      return {};
    }
  }

  private static async saveAll(cache: Record<string, AiScriptCacheValue>): Promise<void> {
    try {
      await chrome.storage.local.set({ [AiScriptCacheService.CACHE_KEY]: cache });
    } catch (error) {
      console.warn('【VideoAdGuard】[AiScriptCache] 保存缓存失败:', error);
    }
  }

  /**
   * 获取缓存的评分结果。
   * @param bvid 视频 BV 号
   */
  public static async get(bvid: string, cid: string, page: number) {
    try {
      const cache = await AiScriptCacheService.getAll();
      const { parts, ...legacy } = cache[bvid] ?? {};
      const part = parts?.[cid];
      const now = Date.now();
      const isExpired = (item?: Partial<AiScriptCacheItem>) =>
        typeof item?.createdAt === 'number' && now - item.createdAt > this.CACHE_EXPIRY_MS;
      const isCurrent = (item?: Partial<AiScriptCacheItem>): item is AiScriptCacheItem =>
        typeof item?.aiScore === 'number' && item.criteriaVersion === AI_SCRIPT_CRITERIA_VERSION
        && typeof item.createdAt === 'number' && !isExpired(item);
      if (isExpired(part) || isExpired(legacy)) {
        if (parts && isExpired(part)) delete parts[cid];
        const freshLegacy = isExpired(legacy) ? undefined : legacy;
        if (freshLegacy?.createdAt || Object.keys(parts ?? {}).length) cache[bvid] = { ...freshLegacy, parts };
        else delete cache[bvid];
        await this.saveAll(cache);
      }
      return {
        part: isCurrent(part) ? part : undefined,
        // 历史评分只曾读取 P1 的字幕。
        legacy: page === 1 && !part && isCurrent(legacy) ? legacy : undefined,
      };
    } catch (error) {
      console.warn('【VideoAdGuard】[AiScriptCache] 获取缓存失败:', error);
      return {};
    }
  }

  /**
   * 保存评分结果到缓存（云端命中时 source 传 'remote'）。
   */
  public static async save(bvid: string, cid: string, item: Omit<AiScriptCacheItem, 'createdAt'>): Promise<void> {
    try {
      const cache = await AiScriptCacheService.getAll();
      const value = cache[bvid] ?? {};
      const freshParts = Object.fromEntries(Object.entries(value.parts ?? {})
        .filter(([, part]) => Date.now() - part.createdAt <= this.CACHE_EXPIRY_MS));
      cache[bvid] = { ...value, parts: { ...freshParts, [cid]: { ...item, createdAt: Date.now() } } };
      await AiScriptCacheService.saveAll(cache);
      console.log(`【VideoAdGuard】[AiScriptCache] 已保存 ${bvid} 的 AI 感评分（来源: ${item.source}）`);
    } catch (error) {
      console.warn('【VideoAdGuard】[AiScriptCache] 保存缓存失败:', error);
    }
  }
}
