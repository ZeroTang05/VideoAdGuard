import { RemoteAdRecord, RemoteAiScriptRecord } from '../types/cloud-cache';
import { AI_SCRIPT_CRITERIA_VERSION } from './prompt';

/** 首页批量查询返回的单视频数据 */
export interface RemoteBatchItem {
  ad: RemoteAdRecord | null;
  aiScript: RemoteAiScriptRecord | null;
}

const CLIENT_VERSION = '1.4.3';

// Cloudflare Worker 端点（兜底）
const DEFAULT_WORKER_URL = 'https://videoadguard-api.0100320.xyz';

// 自建服务器端点：部署 server/ 目录的服务后填入（如 https://cache.example.com）。
// 留空时插件只用 Cloudflare，行为与旧版完全一致。
const SELF_HOSTED_API_URL = '';

interface WorkerResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface CacheQueryResponse {
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
  clientVersion?: string;
}

export class CloudCacheService {
  /**
   * 双后端端点列表：自有服务器在前（读优先、规避 Cloudflare 限额），
   * Cloudflare 兜底。未配置自有服务器时只有 Cloudflare。
   */
  private static async getEndpoints(): Promise<string[]> {
    const endpoints: string[] = [];
    if (SELF_HOSTED_API_URL) endpoints.push(SELF_HOSTED_API_URL);
    endpoints.push(DEFAULT_WORKER_URL);
    return endpoints;
  }

  /**
   * 通过 background script 代理请求后端
   * 超时控制在 background.ts 中实现（3 秒）
   */
  private static async fetchWorker(
    url: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<WorkerResponse | null> {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CLOUD_CACHE_REQUEST',
        payload: {
          url,
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Client-Version': CLIENT_VERSION,
          },
          body,
        },
      });

      if (!response?.success) {
        console.warn('【VideoAdGuard】[CloudCache] 请求失败:', response?.error);
        return null;
      }

      return response.data as WorkerResponse;
    } catch (error) {
      console.warn('【VideoAdGuard】[CloudCache] 请求异常:', error);
      return null;
    }
  }

  /**
   * 顺序尝试各端点读取，返回第一个命中的响应。
   * 命中判定 isHit 为 false（未命中）或请求失败时继续尝试下一端点。
   * @returns 最后一次成功响应（可能未命中），全部失败返回 null
   */
  private static async fetchFirstHit(
    path: string,
    isHit: (data: unknown) => boolean,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, unknown>
  ): Promise<WorkerResponse | null> {
    let lastResponse: WorkerResponse | null = null;
    for (const base of await this.getEndpoints()) {
      const result = await this.fetchWorker(`${base}${path}`, method, body);
      if (result?.success && isHit(result.data)) {
        return result;
      }
      if (result) lastResponse = result;
      // 请求失败（null）继续尝试下一个端点
    }
    return lastResponse;
  }

  /**
   * 并行写入全部端点（双写）：任一成功即视为成功。
   * @returns 是否至少有一个端点保存成功
   */
  private static async saveToAll(
    path: string,
    body: Record<string, unknown>,
    label: string
  ): Promise<boolean> {
    const endpoints = await this.getEndpoints();
    const results = await Promise.allSettled(
      endpoints.map((base) => this.fetchWorker(`${base}${path}`, 'POST', body))
    );

    let savedCount = 0;
    results.forEach((result, index) => {
      const ok = result.status === 'fulfilled' && result.value?.success === true;
      if (ok) savedCount++;
      else console.warn(`【VideoAdGuard】[CloudCache] ${label} 写入 ${endpoints[index]} 失败`);
    });

    if (savedCount > 0) {
      console.log(`【VideoAdGuard】[CloudCache] ${label} 已写入 ${savedCount}/${endpoints.length} 个后端`);
    }
    return savedCount > 0;
  }

  /**
   * 从云端查询广告缓存（自有服务器优先，Cloudflare 兜底）
   */
  static async fetchRemoteCache(bvid: string): Promise<RemoteAdRecord | null> {
    console.log(`【VideoAdGuard】[CloudCache] 查询云端缓存: ${bvid}`);

    const result = await this.fetchFirstHit(
      `/api/cache/${encodeURIComponent(bvid)}`,
      (data) => Boolean((data as CacheQueryResponse)?.adTimeRanges)
    );

    if (!result?.success) {
      console.warn(`【VideoAdGuard】[CloudCache] 请求失败: ${result?.error}`);
      return null;
    }

    try {
      const record = result.data as RemoteAdRecord;
      if (record.bvid !== bvid || !Array.isArray(record.adTimeRanges)) {
        console.warn(`【VideoAdGuard】[CloudCache] 云端数据格式异常: ${bvid}`);
        return null;
      }
      console.log(`【VideoAdGuard】[CloudCache] 云端缓存命中: ${bvid}, 广告区间: ${record.adTimeRanges.length}段, 来源: ${record.source}`);
      return record;
    } catch {
      console.warn(`【VideoAdGuard】[CloudCache] 解析云端数据失败: ${bvid}`);
      return null;
    }
  }

  /**
   * 保存检测结果到云端（双写：自有服务器 + Cloudflare）
   *
   * @param bvid 视频 BV 号
   * @param record 检测结果记录（accuracy 字段由调用方决定）
   */
  static async saveRemoteCache(
    bvid: string,
    record: Omit<RemoteAdRecord, 'bvid'>
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      ...record,
      bvid,
      clientVersion: CLIENT_VERSION,
    };

    console.log(`【VideoAdGuard】[CloudCache] 保存: ${bvid}, 来源: ${body.source}, accuracy: ${body.accuracy}`);

    return this.saveToAll('/api/cache', body, `广告缓存 ${bvid}`);
  }

  /**
   * 批量查询广告与 AI 感评分（首页卡片标注用）。
   * 服务端单次上限 30 个，超出部分由调用方分批。
   */
  static async fetchRemoteBatch(bvids: string[]): Promise<Record<string, RemoteBatchItem> | null> {
    if (!bvids.length) return null;

    const result = await this.fetchFirstHit(
      '/api/batch',
      // 命中 = 至少一个视频有数据；两边都全空也返回最后一次成功响应
      (data) => Object.values((data as Record<string, RemoteBatchItem>) || {}).some((item) => item?.ad || item?.aiScript),
      'POST',
      { bvids: bvids.slice(0, 30) }
    );

    if (!result?.success || !result.data) {
      console.log('【VideoAdGuard】[CloudCache] 批量查询未命中或失败');
      return null;
    }

    return result.data as Record<string, RemoteBatchItem>;
  }

  /**
   * 从云端查询 AI 感评分（自有服务器优先，Cloudflare 兜底）
   */
  static async fetchRemoteAIScript(bvid: string): Promise<RemoteAiScriptRecord | null> {
    const result = await this.fetchFirstHit(
      `/api/ai-script/${encodeURIComponent(bvid)}`,
      (data) => {
        const record = data as RemoteAiScriptRecord | null;
        // 旧格式记录与旧评分标准的记录视为未命中，继续查下一端点
        return Boolean(record && record.bvid === bvid
          && typeof record.aiScore === 'number'
          && record.criteriaVersion === AI_SCRIPT_CRITERIA_VERSION);
      }
    );

    if (!result?.success) {
      console.log(`【VideoAdGuard】[CloudCache] AI 感评分云端查询未命中: ${bvid}`);
      return null;
    }

    const record = result.data as RemoteAiScriptRecord;
    console.log(`【VideoAdGuard】[CloudCache] AI 感评分云端缓存命中: ${bvid}, 分数: ${record.aiScore}`);
    return record;
  }

  /**
   * 保存 AI 感评分到云端（双写：自有服务器 + Cloudflare，单视频单结果覆盖）
   */
  static async saveRemoteAIScript(
    bvid: string,
    record: Omit<RemoteAiScriptRecord, 'bvid' | 'version'>
  ): Promise<boolean> {
    return this.saveToAll(
      '/api/ai-script',
      { ...record, bvid, clientVersion: CLIENT_VERSION },
      `AI 感评分 ${bvid}`
    );
  }
}
