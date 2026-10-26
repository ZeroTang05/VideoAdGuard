import { RemoteAdRecord } from '../types/cloud-cache';

const CLIENT_VERSION = '1.4.3';

// 默认云端端点
const DEFAULT_WORKER_URL = 'https://videoadguard-api.0100320.xyz';

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

interface CacheResultResponse {
  success: boolean;
  data?: { bvid: string; accuracy: 'accurate' | 'inaccurate' };
  error?: string;
  exists?: boolean;
}

export class CloudCacheService {
  /**
   * 获取 Worker 基础 URL
   */
  static async getWorkerUrl(): Promise<string | null> {
    return DEFAULT_WORKER_URL;
  }

  /**
   * 通过 background script 代理请求 Worker
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
   * 从云端查询广告缓存
   */
  static async fetchRemoteCache(bvid: string): Promise<RemoteAdRecord | null> {
    const workerUrl = await this.getWorkerUrl();
    if (!workerUrl) {
      console.log('【VideoAdGuard】[CloudCache] Worker URL 未配置，跳过云端查询');
      return null;
    }

    console.log(`【VideoAdGuard】[CloudCache] 查询云端缓存: ${bvid}`);

    const result = await this.fetchWorker(
      `${workerUrl}/api/cache/${encodeURIComponent(bvid)}`,
      'GET'
    );

    if (!result) {
      console.log(`【VideoAdGuard】[CloudCache] 网络请求失败: ${bvid}`);
      return null;
    }

    if (!result.success) {
      console.warn(`【VideoAdGuard】[CloudCache] 请求失败: ${result.error}`);
      return null;
    }

    // 检查是否存在有效缓存
    const resultData = result.data as CacheQueryResponse | undefined;
    if (!resultData?.adTimeRanges) {
      console.log(`【VideoAdGuard】[CloudCache] 云端无有效缓存: ${bvid}`);
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
   * 保存检测结果到云端
   *
   * @param bvid 视频 BV 号
   * @param record 检测结果记录（accuracy 字段由调用方决定）
   */
  static async saveRemoteCache(
    bvid: string,
    record: Omit<RemoteAdRecord, 'bvid'>
  ): Promise<boolean> {
    const workerUrl = await this.getWorkerUrl();
    if (!workerUrl) {
      console.log(`【VideoAdGuard】[CloudCache] Worker URL 未配置，跳过保存: ${bvid}`);
      return false;
    }

    // 构建请求体
    const body: Record<string, unknown> = {
      ...record,
      bvid,
      clientVersion: CLIENT_VERSION,
    };

    console.log(`【VideoAdGuard】[CloudCache] 保存到云端: ${bvid}, 来源: ${body.source}, accuracy: ${body.accuracy}`);

    const result = await this.fetchWorker(
      `${workerUrl}/api/cache`,
      'POST',
      body
    );

    if (result?.success) {
      console.log(`【VideoAdGuard】[CloudCache] 云端保存成功: ${bvid}`);
    } else {
      console.warn(`【VideoAdGuard】[CloudCache] 云端保存失败: ${bvid}, 错误: ${result?.error}`);
    }

    return result?.success === true;
  }
}