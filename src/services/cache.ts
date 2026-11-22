/**
 * 缓存服务类 - 管理大模型检测结果的本地缓存
 */
export interface CacheItem {
  /** 广告是否存在 */
  exist: boolean;
  /** 商品名称列表 */
  goodName: string[];
  /** 广告时间段 */
  adTimeRanges: number[][];
  /** 检测结果是否可信（用于决定是否自动跳过） */
  isDetectionConfident: boolean;
  /** 缓存来源 */
  source?: 'local' | 'remote';
  /** 检测时间戳 */
  detectedAt: number;
  /** 模型名称 */
  model?: string;
  /** 提供商名称 */
  provider?: string;
  /** accurate: 可用于查询; inaccurate: 用户标记不准确 */
  accuracy?: 'accurate' | 'inaccurate';
  /** ai: AI 检测结果; user: 用户手动修正 */
  recordSource?: 'ai' | 'user';
  /** 创建时间戳（本地缓存用） */
  createdAt: number;
}

/** 旧记录与各分 P 的记录共享一个 BV 键。 */
type CacheValue = Partial<CacheItem> & { parts?: Record<string, CacheItem> };

export class CacheService {
  private static readonly CACHE_KEY = 'videoAdGuard_detectionCache';
  private static readonly LAST_CLEANUP_KEY = 'videoAdGuard_lastCleanupTime';
  private static readonly CACHE_EXPIRY_DAYS = 1; // 缓存过期时间：1天
  private static readonly CACHE_EXPIRY_MS = CacheService.CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  private static readonly CLEANUP_INTERVAL_MS = CacheService.CACHE_EXPIRY_MS; // 清理间隔：1天

  private static legacyRecord(value: CacheValue): CacheItem | undefined {
    const { parts, ...legacy } = value;
    return typeof legacy.createdAt === 'number' ? legacy as CacheItem : undefined;
  }

  /**
   * 获取所有缓存数据
   * @returns 缓存数据对象
   */
  private static async getAllCache(): Promise<Record<string, CacheValue>> {
    try {
      const result = await chrome.storage.local.get(CacheService.CACHE_KEY);
      return result[CacheService.CACHE_KEY] || {};
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 获取缓存失败:', error);
      return {};
    }
  }

  /**
   * 保存所有缓存数据
   * @param cache 缓存数据对象
   */
  private static async saveAllCache(cache: Record<string, CacheValue>): Promise<void> {
    try {
      await chrome.storage.local.set({
        [CacheService.CACHE_KEY]: cache
      });
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 保存缓存失败:', error);
    }
  }

  /**
   * 检查缓存项是否过期
   * @param item 缓存项
   * @returns 是否过期
   */
  private static isExpired(item: CacheItem): boolean {
    // 不准确标记保留到过期，期间允许重新检测当前 P。
    const now = Date.now();
    return (now - item.createdAt) > CacheService.CACHE_EXPIRY_MS;
  }

  /**
   * 获取上次清理时间
   * @returns 上次清理时间戳
   */
  private static async getLastCleanupTime(): Promise<number> {
    try {
      const result = await chrome.storage.local.get(CacheService.LAST_CLEANUP_KEY);
      return result[CacheService.LAST_CLEANUP_KEY] || 0;
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 获取上次清理时间失败:', error);
      return 0;
    }
  }

  /**
   * 设置上次清理时间
   * @param timestamp 时间戳
   */
  private static async setLastCleanupTime(timestamp: number): Promise<void> {
    try {
      await chrome.storage.local.set({
        [CacheService.LAST_CLEANUP_KEY]: timestamp
      });
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 设置上次清理时间失败:', error);
    }
  }

  /**
   * 检查是否需要清理缓存
   * @returns 是否需要清理
   */
  private static async shouldCleanup(): Promise<boolean> {
    const lastCleanupTime = await CacheService.getLastCleanupTime();
    const now = Date.now();
    return (now - lastCleanupTime) > CacheService.CLEANUP_INTERVAL_MS;
  }

  /**
   * 清理过期的缓存项（仅在需要时执行）
   */
  public static async cleanExpiredCache(): Promise<void> {
    try {
      // 检查是否需要清理
      const needsCleanup = await CacheService.shouldCleanup();
      if (!needsCleanup) {
        console.log('【VideoAdGuard】[Cache] 距离上次清理时间不足1天，跳过清理');
        return;
      }

      await CacheService.forceCleanExpiredCache();
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 清理过期缓存失败:', error);
    }
  }

  /**
   * 强制清理过期的缓存项（忽略时间间隔限制）
   */
  public static async forceCleanExpiredCache(): Promise<void> {
    try {
      console.log('【VideoAdGuard】[Cache] 开始清理过期缓存...');
      const cache = await CacheService.getAllCache();
      let cleanedCount = 0;

      // 过滤掉过期的缓存项
      const cleanedCache: Record<string, CacheValue> = {};
      for (const [key, value] of Object.entries(cache)) {
        const legacy = this.legacyRecord(value);
        const parts = Object.entries(value.parts ?? {});
        const freshParts = parts.filter(([, item]) => !this.isExpired(item));
        const freshLegacy = legacy && !this.isExpired(legacy) ? legacy : undefined;
        if (freshLegacy || freshParts.length) {
          cleanedCache[key] = { ...freshLegacy, parts: Object.fromEntries(freshParts) };
        }
        cleanedCount += parts.length - freshParts.length + Number(Boolean(legacy && !freshLegacy));
      }

      // 保存更新后的缓存和清理时间
      await CacheService.saveAllCache(cleanedCache);
      await CacheService.setLastCleanupTime(Date.now());

      if (cleanedCount > 0) {
        console.log(`【VideoAdGuard】[Cache] 清理了 ${cleanedCount} 个过期缓存项`);
      } else {
        console.log('【VideoAdGuard】[Cache] 没有过期缓存项需要清理');
      }
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 强制清理过期缓存失败:', error);
    }
  }

  /** 同时读取当前 P 与旧 BV 结果，保留当前 P 的纠错状态。 */
  public static async getDetectionResults(bvid: string, cid: string) {
    const value = (await this.getAllCache())[bvid] ?? {};
    const part = value.parts?.[cid];
    const legacy = this.legacyRecord(value);
    return {
      part: part && !this.isExpired(part) ? part : undefined,
      legacy: legacy && legacy.accuracy !== 'inaccurate' && !this.isExpired(legacy) ? legacy : undefined,
    };
  }

  /**
   * 保存检测结果到缓存
   * @param bvid 视频BV号
   * @param exist 广告是否存在
   * @param good_name 商品名称列表
   * @param adTimeRanges 广告时间段
   * @param isDetectionConfident 检测结果是否可信
   * @param source 缓存来源
   * @param remoteDetectedAt 云端缓存的检测时间
   * @param model 模型名称
   * @param provider 提供商名称
   */
  public static async saveDetectionResult(
    bvid: string,
    cid: string | undefined,
    exist: boolean,
    good_name: string[],
    adTimeRanges: number[][],
    isDetectionConfident: boolean = false,
    source: 'local' | 'remote' = 'local',
    remoteDetectedAt?: number,
    model?: string,
    provider?: string
  ): Promise<void> {
    try {
      const cache = await CacheService.getAllCache();
      const cacheItem: CacheItem = {
        exist,
        goodName: good_name,
        adTimeRanges,
        isDetectionConfident,
        createdAt: Date.now(),
        source,
        detectedAt: remoteDetectedAt || Date.now(),
        model: model || 'unknown',
        provider: provider || 'unknown',
        accuracy: 'accurate',
        recordSource: 'ai',
      };

      const value = cache[bvid] ?? {};
      cache[bvid] = cid
        ? { ...value, parts: { ...value.parts, [cid]: cacheItem } }
        : { ...value, ...cacheItem };
      await CacheService.saveAllCache(cache);

      console.log(`【VideoAdGuard】[Cache] 已保存 ${bvid} 的检测结果到缓存（来源: ${source}）`);
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 保存缓存失败:', error);
    }
  }

  /**
   * 更新缓存中的广告时间段（用于手动调整后的同步）
   * @param bvid 视频BV号
   * @param adTimeRanges 最新的广告时间段
   * @param recordSource 可选：标记来源为 'user'（用户手动修正）
   * @param isConfident 可选：标记为可信（手动修正后应为 true）
   */
  public static async updateAdTimeRanges(bvid: string, cid: string, adTimeRanges: number[][], recordSource?: 'user', isConfident?: boolean): Promise<void> {
    try {
      const cache = await CacheService.getAllCache();
      const value = cache[bvid] ?? {};
      const item = value.parts?.[cid] ?? this.legacyRecord(value);

      if (!item) {
        console.log(`【VideoAdGuard】[Cache] 未找到 ${bvid} 的缓存，跳过广告区间更新`);
        return;
      }

      const updated = { ...item, adTimeRanges };
      updated.exist = adTimeRanges.length > 0 ? true : false;
      updated.createdAt = Date.now();
      // 用户手动修正广告区间时，标记来源为 user，同时将 accuracy 改为 accurate
      if (recordSource === 'user') {
        updated.recordSource = 'user';
        updated.accuracy = 'accurate';
        updated.isDetectionConfident = isConfident ?? true;
      }

      cache[bvid] = { ...value, parts: { ...value.parts, [cid]: updated } };
      await CacheService.saveAllCache(cache);
      console.log(`【VideoAdGuard】[Cache] 已同步 ${bvid} 的手动调整广告区间到缓存`);
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 更新广告区间缓存失败:', error);
    }
  }

  /**
   * 删除指定视频的缓存
   * @param bvid 视频BV号
   */
  public static async deleteDetectionResult(bvid: string): Promise<void> {
    try {
      const cache = await CacheService.getAllCache();

      
      if (cache[bvid]) {
        delete cache[bvid];
        await CacheService.saveAllCache(cache);
        console.log(`【VideoAdGuard】[Cache] 已删除 ${bvid} 的缓存`);
      }
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 删除缓存失败:', error);
    }
  }

  /**
   * 清空所有缓存
   */
  public static async clearAllCache(): Promise<void> {
    try {
      await chrome.storage.local.remove(CacheService.CACHE_KEY);
      console.log('【VideoAdGuard】[Cache] 已清空所有缓存');
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 清空缓存失败:', error);
    }
  }

  /**
   * 获取缓存统计信息
   * @returns 缓存统计信息
   */
  public static async getCacheStats(): Promise<{
    totalCount: number;
    expiredCount: number;
    validCount: number;
    totalSize: number;
    lastCleanupTime: number;
    nextCleanupTime: number;
  }> {
    try {
      const cache = await CacheService.getAllCache();
      const entries = Object.values(cache).flatMap(value => {
        const legacy = this.legacyRecord(value);
        const parts = Object.values(value.parts ?? {});
        return legacy ? [legacy, ...parts] : parts;
      });
      const lastCleanupTime = await CacheService.getLastCleanupTime();

      let expiredCount = 0;
      let validCount = 0;

      for (const item of entries) {
        if (CacheService.isExpired(item)) {
          expiredCount++;
        } else {
          validCount++;
        }
      }

      return {
        totalCount: entries.length,
        expiredCount,
        validCount,
        totalSize: JSON.stringify(cache).length,
        lastCleanupTime,
        nextCleanupTime: lastCleanupTime + CacheService.CLEANUP_INTERVAL_MS
      };
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 获取缓存统计失败:', error);
      return {
        totalCount: 0,
        expiredCount: 0,
        validCount: 0,
        totalSize: 0,
        lastCleanupTime: 0,
        nextCleanupTime: 0
      };
    }
  }

  /**
   * 标记缓存为不准确，下次进入时会重新检测
   * @param bvid 视频BV号
   */
  public static async markAsInaccurate(bvid: string, cid: string): Promise<void> {
    try {
      const cache = await CacheService.getAllCache();
      const value = cache[bvid] ?? {};
      const item = value.parts?.[cid] ?? this.legacyRecord(value);

      if (item) {
        cache[bvid] = {
          ...value,
          parts: { ...value.parts, [cid]: { ...item, accuracy: 'inaccurate', createdAt: Date.now() } },
        };
        await CacheService.saveAllCache(cache);
        console.log(`【VideoAdGuard】[Cache] 已标记 ${bvid} 的缓存为不准确`);
      }
    } catch (error) {
      console.warn('【VideoAdGuard】[Cache] 标记缓存失败:', error);
    }
  }
}
