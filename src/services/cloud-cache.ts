import { RemoteAdRecord, RemoteAiScriptRecord } from '../types/cloud-cache';
import { AI_SCRIPT_CRITERIA_VERSION } from './prompt';
import type { VideoPart } from './bilibili';

/** 首页批量查询返回的单视频数据 */
export interface RemoteBatchItem {
  ad: RemoteAdRecord | null;
  aiScript: RemoteAiScriptRecord | null;
  aiScriptLabel?: boolean;
}

export type RemoteAiScriptResult =
  | { source: 'user'; isAiScript: boolean }
  | { source: 'ai'; record: RemoteAiScriptRecord; matchedPart: boolean };

const CLIENT_VERSION = '1.4.3';

// Cloudflare Worker 端点（兜底）
const DEFAULT_WORKER_URL = 'https://videoadguard-api.0100320.xyz';

// 自建服务器端点：留空时只使用 Cloudflare。
const SELF_HOSTED_API_URL = 'https://vag-api.xiaobaozi.cn';

interface WorkerResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  aiScriptLabel?: boolean;
  parts?: Record<string, unknown>;
  aiScriptLabelParts?: Record<string, { isAiScript: boolean }>;
}

export class CloudCacheService {
  /** 共享名单在自建服务统一发布，读取结果只包含已达发布条件的 UID。 */
  static async fetchAiCommentBlocklist(): Promise<string[] | null> {
    const result = await this.fetchWorker(`${SELF_HOSTED_API_URL}/api/ai-comment-blocklist`, 'GET');
    if (!result?.success) return null;
    const data = result.data as { uids?: unknown } | undefined;
    return Array.isArray(data?.uids) && data.uids.every(uid => typeof uid === 'string') ? data.uids : null;
  }

  /** 每次点击只向计数服务提交一次。 */
  static async reportAiComment(uid: string): Promise<boolean> {
    const result = await this.fetchWorker(`${SELF_HOSTED_API_URL}/api/ai-comment-blocklist`, 'POST', { uid });
    return result?.success === true;
  }

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
    body?: Record<string, unknown>,
    writeOrderKey?: string,
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
          writeOrderKey,
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
   * 批量查询需要区分“没有任何标签”和“请求失败”，可显式保留成功但未命中的响应。
   */
  private static async fetchFirstHit(
    path: string,
    isHit: (response: WorkerResponse) => boolean,
    { method = 'GET', body, acceptMiss = false, selfHostedOnly = false }: {
      method?: 'GET' | 'POST';
      body?: Record<string, unknown>;
      acceptMiss?: boolean;
      selfHostedOnly?: boolean;
    } = {}
  ): Promise<WorkerResponse | null> {
    let lastMiss: WorkerResponse | null = null;
    const endpoints = selfHostedOnly ? [SELF_HOSTED_API_URL].filter(Boolean) : await this.getEndpoints();
    for (const base of endpoints) {
      const result = await this.fetchWorker(`${base}${path}`, method, body);
      if (!result?.success) continue;
      if (isHit(result)) return result;
      if (acceptMiss) lastMiss = result;
    }
    return lastMiss;
  }

  /**
   * 并行写入全部端点（双写）：任一成功即视为成功。
   * @returns 是否至少有一个端点保存成功
   */
  private static async saveToAll(
    path: string,
    body: Record<string, unknown>,
    label: string,
    writeOrderKey?: string,
  ): Promise<boolean> {
    const endpoints = await this.getEndpoints();
    const results = await Promise.allSettled(
      endpoints.map((base) => this.fetchWorker(`${base}${path}`, 'POST', body, writeOrderKey))
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
  static async fetchRemoteCache(bvid: string, cid: string) {
    let legacy: RemoteAdRecord | undefined;
    const path = `/api/cache/${encodeURIComponent(bvid)}?parts=1`;
    const result = await this.fetchFirstHit(path, ({ data, parts }) => {
      const record = data as RemoteAdRecord | null;
      if (!legacy && record?.bvid === bvid && Array.isArray(record.adTimeRanges)) legacy = record;
      return Boolean(parts?.[cid]);
    });
    return { part: result?.parts?.[cid] as RemoteAdRecord | undefined, legacy };
  }

  /**
   * 保存检测结果到云端（双写：自有服务器 + Cloudflare）
   *
   * @param part 当前分 P
   * @param record 检测结果记录（accuracy 字段由调用方决定）
   */
  static async saveRemoteCache(
    { bvid, cid, page }: VideoPart,
    record: Omit<RemoteAdRecord, 'bvid'>
  ): Promise<boolean> {
    const body: Record<string, unknown> = {
      ...record,
      bvid,
      cid,
      page,
      clientVersion: CLIENT_VERSION,
    };

    console.log(`【VideoAdGuard】[CloudCache] 保存: ${bvid}, 来源: ${body.source}, accuracy: ${body.accuracy}`);

    return this.saveToAll('/api/cache/part', body, `广告缓存 ${bvid}`);
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
      ({ data }) => Object.values((data as Record<string, RemoteBatchItem>) || {}).some(
        (item) => item?.ad || item?.aiScript || typeof item?.aiScriptLabel === 'boolean'
      ),
      { method: 'POST', body: { bvids: bvids.slice(0, 30) }, acceptMiss: true }
    );

    if (!result?.success || !result.data) {
      console.log('【VideoAdGuard】[CloudCache] 批量查询未命中或失败');
      return null;
    }

    return result.data as Record<string, RemoteBatchItem>;
  }

  /** 人工标注优先，历史 BV 评分只对应 P1。 */
  static async fetchRemoteAIScript({ bvid, cid, page }: VideoPart, hasLocalScore: boolean): Promise<RemoteAiScriptResult | null> {
    let matched: RemoteAiScriptResult | undefined;
    let legacy: RemoteAiScriptResult | undefined;
    const isCurrentScore = (item: unknown): item is RemoteAiScriptRecord => {
      const score = item as RemoteAiScriptRecord | null;
      return Boolean(score && score.bvid === bvid && typeof score.aiScore === 'number'
        && score.criteriaVersion === AI_SCRIPT_CRITERIA_VERSION);
    };
    await this.fetchFirstHit(
      `/api/ai-script/${encodeURIComponent(bvid)}?parts=1`,
      ({ data, parts, aiScriptLabel, aiScriptLabelParts }) => {
        const label = aiScriptLabelParts?.[cid]?.isAiScript;
        if (typeof label === 'boolean') {
          matched = { source: 'user', isAiScript: label };
          return true;
        }
        const score = parts?.[cid];
        if (!matched && isCurrentScore(score)) matched = { source: 'ai', record: score, matchedPart: true };
        if (page === 1 && legacy?.source !== 'user') {
          if (typeof aiScriptLabel === 'boolean') legacy = { source: 'user', isAiScript: aiScriptLabel };
          else if (!legacy && !score && isCurrentScore(data)) legacy = { source: 'ai', record: data, matchedPart: false };
        }
        return false;
      },
      { selfHostedOnly: hasLocalScore }
    );
    if (matched?.source !== 'user' && legacy?.source === 'user') return legacy;
    return matched ?? legacy ?? null;
  }

  /** 同一分 P 的人工标注以最后一次保存为准。 */
  static async saveRemoteAIScriptLabel({ bvid, cid, page }: VideoPart, isAiScript: boolean): Promise<boolean> {
    return this.saveToAll(
      '/api/ai-script-label/part', { bvid, cid, page, isAiScript }, `文案标注 ${bvid} P${page}`, `${bvid}:${cid}`,
    );
  }

  static async saveRemoteAIScript(
    { bvid, cid, page }: VideoPart,
    record: Omit<RemoteAiScriptRecord, 'bvid' | 'version'>
  ): Promise<boolean> {
    return this.saveToAll(
      '/api/ai-script/part',
      { ...record, bvid, cid, page, clientVersion: CLIENT_VERSION },
      `AI 感评分 ${bvid} P${page}`
    );
  }
}
