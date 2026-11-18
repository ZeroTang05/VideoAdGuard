/**
 * AI 感评分结果的本地缓存。
 * 与广告检测缓存分开存储：数据结构不同、互不覆盖。
 */

import { AI_SCRIPT_CRITERIA_VERSION } from './prompt';

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

export class AiScriptCacheService {
  private static readonly CACHE_KEY = 'videoAdGuard_aiScriptCache';
  private static readonly CACHE_EXPIRY_DAYS = 1; // 与广告缓存一致：1 天过期
  private static readonly CACHE_EXPIRY_MS = AiScriptCacheService.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  private static async getAll(): Promise<Record<string, AiScriptCacheItem>> {
    try {
      const result = await chrome.storage.local.get(AiScriptCacheService.CACHE_KEY);
      return result[AiScriptCacheService.CACHE_KEY] || {};
    } catch (error) {
      console.warn('【VideoAdGuard】[AiScriptCache] 获取缓存失败:', error);
      return {};
    }
  }

  private static async saveAll(cache: Record<string, AiScriptCacheItem>): Promise<void> {
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
  public static async get(bvid: string): Promise<AiScriptCacheItem | null> {
    try {
      const cache = await AiScriptCacheService.getAll();
      const item = cache[bvid];

      if (!item) return null;

      // 旧格式记录（无 aiScore 字段）与旧评分标准的记录均视为未命中，等新检测覆盖
      if (typeof item.aiScore !== 'number') return null;
      if (item.criteriaVersion !== AI_SCRIPT_CRITERIA_VERSION) {
        console.log(`【VideoAdGuard】[AiScriptCache] ${bvid} 缓存为旧评分标准（v${item.criteriaVersion || 1}），重新检测`);
        return null;
      }

      // 过期则删除并视为未命中
      if (Date.now() - item.createdAt > AiScriptCacheService.CACHE_EXPIRY_MS) {
        delete cache[bvid];
        await AiScriptCacheService.saveAll(cache);
        return null;
      }

      return item;
    } catch (error) {
      console.warn('【VideoAdGuard】[AiScriptCache] 获取缓存失败:', error);
      return null;
    }
  }

  /**
   * 保存评分结果到缓存（云端命中时 source 传 'remote'）。
   */
  public static async save(bvid: string, item: Omit<AiScriptCacheItem, 'createdAt'>): Promise<void> {
    try {
      const cache = await AiScriptCacheService.getAll();
      cache[bvid] = { ...item, createdAt: Date.now() };
      await AiScriptCacheService.saveAll(cache);
      console.log(`【VideoAdGuard】[AiScriptCache] 已保存 ${bvid} 的 AI 感评分（来源: ${item.source}）`);
    } catch (error) {
      console.warn('【VideoAdGuard】[AiScriptCache] 保存缓存失败:', error);
    }
  }
}
