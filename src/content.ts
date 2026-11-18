import './utils/logger';
import { BilibiliService } from './services/bilibili';
import { AIService } from './services/ai';
import { AI_SCRIPT_CRITERIA_VERSION } from './services/prompt';
import { WhitelistService } from './services/whitelist';
import { AudioService } from './services/audio';
import { CacheService } from './services/cache';
import { CloudCacheService } from './services/cloud-cache';
import { AiScriptCacheService } from './services/ai-script-cache';
import { isAutoSkipConfident } from './utils/ad-confidence';
import { normalizeErrorForUser } from './utils/errors';
import { sampleScriptText } from './utils/script-samples';
import { parseAiStyleScore } from './utils/script-result';
import { VideoCardAnnotator } from './services/video-card-annotator';
import { getVideoCardScenarios, isBilibiliVideoPage } from './utils/video-page';

// 新增：广告片段接口，用于支持交互状态
interface AdSegment {
  id: string;
  start: number;
  end: number;
  active: boolean; // true=绿色/跳过, false=灰色/不跳过
}

// 语音识别字幕分段
interface TranscriptionSegment {
  text?: string;
  start?: number;
  end?: number;
}

// 语音识别结果
interface TranscriptionResult {
  text?: string;
  segments?: TranscriptionSegment[];
}

// 字幕条目
interface CaptionItem {
  content: string;
  from: number;
  to: number;
  location?: number;
}

// 字幕数据结构
interface CaptionsData {
  body: CaptionItem[];
}

export interface AdDetectionJSON {
  exist: boolean;
  good_name: string[];
  index_lists: number[][];
}

/** 
 * 从回复中安全抽取 JSON，做类型兜底、索引区间清洗与合并。
 * @param raw  LLM 原始回复（可能带说明/反引号/中文引号）
 * @param captionsLength  字幕条目数，用于索引边界修正
 */
export function parseAdResult(raw: string, captionsLength = 0): AdDetectionJSON {
  const EMPTY: AdDetectionJSON = { exist: false, good_name: [], index_lists: [] };
  if (!raw || typeof raw !== "string") return EMPTY;

  // 去掉代码块包裹 + 捕获最大花括号块
  let s = raw.trim()
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ""))
    .replace(/^[\s\S]*?({[\s\S]*})[\s\S]*$/m, "$1")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"') // 中文/弯引号 -> "
    .replace(/[\u2018\u2019\u2032]/g, "'");

  let obj: any = null;
  try {
    obj = JSON.parse(s);
  } catch {
    const match = raw.match(/{[\s\S]*}/);
    if (match) {
      const cand = match[0]
        .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
        .replace(/[\u2018\u2019\u2032]/g, "'");
      try { obj = JSON.parse(cand); } catch { obj = null; }
    }
  }
  if (!obj || typeof obj !== "object") return EMPTY;

  const out: AdDetectionJSON = {
    exist: typeof obj.exist === "boolean" ? obj.exist : false,
    good_name: Array.isArray(obj.good_name) ? (obj.good_name as unknown[]).filter((x: unknown) => typeof x === "string") as string[] : [],
    index_lists: Array.isArray(obj.index_lists) ? obj.index_lists : []
  };

  // 索引清洗：二维整型区间，边界修正，排序合并
  const N = Math.max(0, captionsLength | 0);
  const cleaned: number[][] = [];
  for (const seg of out.index_lists) {
    if (!Array.isArray(seg) || seg.length !== 2) continue;
    let [a, b] = seg;
    if (typeof a !== "number" || typeof b !== "number") continue;
    a = Math.max(0, Math.floor(a));
    b = Math.max(0, Math.floor(b));
    if (N > 0) { a = Math.min(a, N - 1); b = Math.min(b, N - 1); }
    if (a > b) [a, b] = [b, a];
    cleaned.push([a, b]);
  }
  cleaned.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: number[][] = [];
  for (const seg of cleaned) {
    if (!merged.length || seg[0] > merged[merged.length - 1][1] + 1) {
      merged.push([seg[0], seg[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], seg[1]);
    }
  }
  out.index_lists = merged;

  // 没有有效片段则强制 exist=false
  if (!out.index_lists.length && out.exist === true) {
    out.exist = false;
  }
  return out;
}

class AdDetector {
  public static adDetectionResult: string | null = null; // 状态存储
  private static adTimeRanges: number[][] = []; // 存储广告时间段 (仅包含active=true的，兼容旧逻辑)
  private static adSegments: AdSegment[] = []; // 新增：存储详细的广告片段状态 (支持交互)
  private static validIndexLists: number[][] = []; // 存储原始广告索引区间
  private static userModifiedSegments: boolean = false; // 用户是否手动调整过广告区间
  private static timeUpdateListener: (() => void) | null = null; // 用于存储 timeupdate 监听器的引用
  private static adMarkerLayer: HTMLElement | null = null; // 添加标记层引用
  private static skipNotificationElement: HTMLElement | null = null; // 跳过提示元素引用
  private static skipButtonElement: HTMLElement | null = null; // 跳过按钮元素引用
  private static feedbackButtonElement: HTMLElement | null = null; // 反馈按钮元素引用
  private static skipNotificationTimeout: number | null = null; // 跳过提示的延时器

  /** 公开获取当前广告时间段（供消息处理器外部访问） */
  public static getAdTimeRanges(): number[][] {
    return this.adTimeRanges;
  }

  /** 公开获取用户是否手动修改过区间（供消息处理器外部访问） */
  public static getUserModifiedSegments(): boolean {
    return this.userModifiedSegments;
  }

  /**
   * 从URL中提取BV号的通用方法
   * @param url 可选，指定URL。如果不提供则使用当前页面URL
   * @returns BV号字符串，找不到时抛出异常
   */
  public static getBvidFromUrl(url?: string): string {
    const targetUrl = url || window.location.href;

    // 先尝试从路径中匹配
    const pathMatch = targetUrl.match(/BV[\w]+/);
    if (pathMatch) return pathMatch[0];

    // 从路径中匹配av号
    const avMatch = targetUrl.match(/av(\d+)/);
    if (avMatch) {
      const avNumber = avMatch[1];
      // 将av号转换为BV号
      return BilibiliService.convertAvToBv(avNumber);
    }

    // 如果路径中没有，尝试从查询参数中获取
    try {
      const urlObj = new URL(targetUrl);
      const bvid = urlObj.searchParams.get('bvid');
      if (bvid) return bvid;
    } catch (error) {
      throw new Error(normalizeErrorForUser('接口地址无效', 'detection'));
    }

    throw new Error(normalizeErrorForUser('未找到视频ID', 'detection'));
  }

  private static resetState() {
    // 重置所有静态变量
    this.adDetectionResult = null;
    this.adTimeRanges = [];
    this.adSegments = []; // 重置片段
    this.validIndexLists = [];
    this.userModifiedSegments = false;

    // 清理延时器
    if (this.skipNotificationTimeout) {
      clearTimeout(this.skipNotificationTimeout);
      this.skipNotificationTimeout = null;
    }

    // 清理跳过按钮
    this.removeSkipButton();

    // 清理标记层
    this.removeAdMarkers();

    // 清理跳过提示
    this.removeSkipNotification();

    // 移除事件监听器
    this.removeAutoSkipListener();
  }

  /**
   * 统一应用检测结果并初始化 UI（本地缓存、云端缓存、AI 检测三条路径共用）
   */
  private static async applyDetectionResult(
    bvid: string,
    result: { exist: boolean; goodName: string[]; adTimeRanges: number[][]; isDetectionConfident: boolean },
    source: 'local' | 'remote' | 'ai'
  ): Promise<void> {
    const sourceLabel = source === 'local' ? '缓存' : source === 'remote' ? '云端' : '';

    const videoElement = document.querySelector('video');

    if (result.exist && result.adTimeRanges.length > 0) {
      this.initAdSegments(result.adTimeRanges);

      this.adDetectionResult = (this.adDetectionResult ? this.adDetectionResult + ' | ' : '')
        + `发现${result.adTimeRanges.length}处广告${sourceLabel ? `（${sourceLabel}）` : ''}：${
          result.adTimeRanges.map(([start, end]) => `${this.second2time(start)}~${this.second2time(end)}`).join(' | ')
        }`;

      if (videoElement) {
        this.createAdMarkers(videoElement);

        // 置信度由各来源在调用前统一计算（见 isAutoSkipConfident），此处直接应用
        const { autoSkipAd } = await chrome.storage.local.get({ autoSkipAd: false });
        if (autoSkipAd && result.isDetectionConfident) {
          console.log(`【VideoAdGuard】设置自动跳过监听器${sourceLabel ? `（${sourceLabel}结果）` : ''}`);
          this.setupAutoSkip(videoElement);
        }
      }
    } else {
      this.adDetectionResult = (this.adDetectionResult ? this.adDetectionResult + ' | ' : '')
        + `无广告内容${sourceLabel ? `（${sourceLabel}）` : ''}`;
      this.removeAutoSkipListener();
    }

    // 检测流程完成后，无论是否有广告，都显示反馈按钮
    if (videoElement) {
      this.createSkipButton(videoElement, result.exist && result.adTimeRanges.length > 0);
    }
  }

  /**
   * 将 adTimeRanges (纯时间数组) 初始化为 adSegments (带状态的对象数组)
   */
  private static initAdSegments(timeRanges: number[][]) {
    this.adSegments = timeRanges.map((range, index) => ({
      id: `ad-seg-${Date.now()}-${index}`,
      start: range[0],
      end: range[1],
      active: true // 默认为激活状态
    }));
    // 同步回 adTimeRanges 确保一致
    this.syncAdTimeRanges();
  }

  /**
   * 根据 adSegments 的状态更新 adTimeRanges
   * 只有 active 为 true 的片段才会进入 adTimeRanges 被自动跳过
   */
  private static syncAdTimeRanges() {
    this.adTimeRanges = this.adSegments
      .filter(seg => seg.active)
      .map(seg => [seg.start, seg.end]);
      
    // 如果有自动跳过监听器，由于引用的 adTimeRanges 内容变了，逻辑会自动应用新范围
    // 但为了确保日志和状态正确，打印一下
    // console.log('【VideoAdGuard】同步广告区间:', this.adTimeRanges);
  }

  private static async persistAdSegmentsToCache() {
    try {
      const bvid = this.getBvidFromUrl();
      // 用户手动修正广告区间时，标记 recordSource 为 'user'，同时标记为可信
      const recordSource = this.userModifiedSegments ? 'user' : undefined;
      const isConfident = this.userModifiedSegments ? true : undefined;
      await CacheService.updateAdTimeRanges(bvid, this.adTimeRanges, recordSource, isConfident);
    } catch (error) {
      console.warn('【VideoAdGuard】手动调整广告区间未能同步缓存:', error);
    }
  }


  public static async analyze() {
    try {
      // 检查插件是否启用（默认为启用，只有明确设置为 false 时才禁用）
      const settings = await chrome.storage.local.get(['enableExtension', 'restrictedMode']);
      if (settings.enableExtension === false) {
        console.log('【VideoAdGuard】插件已禁用，跳过广告检测');
        this.adDetectionResult = (this.adDetectionResult ? this.adDetectionResult + ' | ' : '') +'插件已禁用';
        return;
      }

      // 在分析开始时先重置状态
      this.resetState();

      const bvid = this.getBvidFromUrl();

      // 记录本次检测使用的模型信息，供云端缓存上传使用
      let llmMeta = { provider: 'unknown', model: 'unknown' };

      // 清理过期缓存
      await CacheService.cleanExpiredCache();

      // 先查找本地缓存
      const cachedResult = await CacheService.getDetectionResult(bvid);
      if (cachedResult) {
        console.log('【VideoAdGuard】使用本地缓存的检测结果');
        await this.applyDetectionResult(bvid, {
          exist: cachedResult.exist,
          goodName: cachedResult.goodName,
          adTimeRanges: cachedResult.adTimeRanges,
          isDetectionConfident: cachedResult.isDetectionConfident,
        }, 'local');
        return;
      }

      // 本地缓存未命中：并行查询云端缓存和视频信息
      const [videoInfoResult, remoteCacheResult] = await Promise.allSettled([
        BilibiliService.getVideoInfo(bvid),
        CloudCacheService.fetchRemoteCache(bvid),
      ]);

      // 云端缓存命中 → 应用结果并写入本地缓存
      if (remoteCacheResult.status === 'fulfilled' && remoteCacheResult.value) {
        const remote = remoteCacheResult.value;
        console.log('【VideoAdGuard】使用云端缓存的检测结果');

        // 云端标志位可能因上传时视频未加载（duration 为 NaN）而不可靠，
        // 这里基于当前视频重新计算，本地缓存与应用行为使用同一个值，避免首次访问与刷新后行为不一致
        const videoElement = document.querySelector('video');
        const isConfident = isAutoSkipConfident(remote.adTimeRanges, videoElement?.duration ?? NaN);

        // 写入本地缓存（标记来源为 remote）
        await CacheService.saveDetectionResult(bvid, remote.exist, remote.goodName, remote.adTimeRanges, isConfident, 'remote', remote.detectedAt, remote.model, remote.provider);

        await this.applyDetectionResult(bvid, {
          exist: remote.exist,
          goodName: remote.goodName,
          adTimeRanges: remote.adTimeRanges,
          isDetectionConfident: isConfident,
        }, 'remote');
        return;
      }

      // 云端未命中，继续使用视频信息
      if (videoInfoResult.status !== 'fulfilled') {
        throw videoInfoResult.reason;
      }
      const videoInfo = videoInfoResult.value;

      // 检查UP主是否在白名单中
      const isUPWhitelisted = await WhitelistService.isWhitelisted(videoInfo.owner.mid.toString());
      if (isUPWhitelisted) {
        console.log('【VideoAdGuard】当前UP主在白名单中，跳过广告检测');
        this.adDetectionResult = (this.adDetectionResult ? this.adDetectionResult + ' | ' : '') + 'UP主在白名单中，跳过检测';
        return;
      }

      const topComments = await BilibiliService.getTopComments(bvid);
      const topComment = topComments?.message || null;
      const jumpUrls = topComments?.jump_url || null;
      let jumpUrlMessages: Record<string, Record<string, any>> = {};
      if(topComment && (Object.keys(jumpUrls).length===0 || jumpUrls===null)){
        jumpUrlMessages["置顶评论"] = {"是否有链接": false};
      }
      else if(jumpUrls) {
        for (const [jumpUrl, jumpUrlDict] of Object.entries(jumpUrls)) {
          if (typeof jumpUrlDict !== 'object' || jumpUrlDict === null || (jumpUrlDict as any)?.extra?.is_word_search === true) {
            jumpUrlMessages["置顶评论"] = {"是否为商品链接": false};
            continue;
          }
          const jumpUrlMessage: Record<string, any> = {};
          if((jumpUrlDict as any)?.extra?.goods_item_id || (jumpUrlDict as any)?.pc_url !== ""){
            jumpUrlMessage["是否为官方商品链接"] = true
          }
          else{
            jumpUrlMessage["是否为官方商品链接"] = false
          }
          if ((jumpUrlDict as any)?.app_name !== ""){
            jumpUrlMessage["平台名称"] = (jumpUrlDict as any).app_name;
          }
          if ((jumpUrlDict as any)?.title !== ""){
            jumpUrlMessage["链接标题"] = (jumpUrlDict as any).title;
          }
          jumpUrlMessages[jumpUrl] = jumpUrlMessage;
        }
      }

      // 检查是否开启限制模式
      const isRestrictedMode = settings.restrictedMode || false;
      console.log('【VideoAdGuard】限制模式状态:', isRestrictedMode ? '已开启' : '已关闭');
      let hasAdCondition = false;
      let good_name: string[] = [];
      if (isRestrictedMode) { 
        // TODO: 用户需要在此处添加广告预检测条件
        // 示例条件判断逻辑（用户可以根据需要修改）：
        for (const [jumpUrl, jumpUrlMessage] of Object.entries(jumpUrlMessages)){
          if (jumpUrlMessage["是否为官方商品链接"]) {
            hasAdCondition = true;
            const ad_text = "置顶评论：" + topComment + " 链接标题：" + jumpUrlMessage["链接标题"];
            try {
              const response = await AIService.extractProductName(ad_text, String(jumpUrlMessage['链接标题']));
              good_name.push(response);
              console.log('【VideoAdGuard】限制模式：成功提取商品名称:', response);
            } catch (error) {
              console.warn('【VideoAdGuard】限制模式：提取商品名称失败:', error);
              // 如果提取失败，使用原始链接标题作为商品名
              good_name.push(ad_text);
            }
          }
        }
        // 如果没有检测到广告条件，则直接返回
        if (!hasAdCondition) {
          console.log('【VideoAdGuard】限制模式：未检测到广告条件，跳过大模型分析');
          this.adDetectionResult = (this.adDetectionResult ? this.adDetectionResult + ' | ' : '') + '未检测到广告条件';
          this.removeAutoSkipListener();
          // 保存无广告结果到缓存
          await CacheService.saveDetectionResult(bvid, false, [], [], false);
          return;
        }
      }

      const playerInfo = await BilibiliService.getPlayerInfo(bvid, videoInfo.cid);

      // 获取字幕数据 - 统一的数据结构
      let captions: Record<number, string> = {};
      let captionsData: CaptionsData | null = null;

      // 判断是否有官方字幕
      if (playerInfo.subtitle?.subtitles?.length) {
        // 有官方字幕 - 使用官方字幕
        console.log('【VideoAdGuard】使用官方字幕进行检测');
        const captionsUrl = 'https:' + playerInfo.subtitle.subtitles[0].subtitle_url;
        captionsData = await BilibiliService.getCaptions(captionsUrl);

        // 将官方字幕转换为统一格式
        captionsData!.body.forEach((caption: CaptionItem, index: number) => {
          captions[index] = caption.content;
        });

        console.log('【VideoAdGuard】官方字幕数据已加载:', {captions});
      } else {
        // 无官方字幕 - 尝试使用音频识别
        const audioSettings = await chrome.storage.local.get(['enableAudioTranscription']);
        if (audioSettings.enableAudioTranscription) {
          console.log('【VideoAdGuard】无官方字幕，尝试音频识别');
          try {
            // 使用完整的音频处理和识别流程
            const playUrlInfo = await BilibiliService.getPlayUrl(bvid, videoInfo.cid);
            const result = await AudioService.processAndTranscribeAudio(playUrlInfo, {
              responseFormat: 'verbose_json'
            });

            if (result) {
              console.log('【VideoAdGuard】音频识别完成:', result.transcription.text);

              // 将语音识别结果转换为统一的字幕格式
              if (result.transcription.segments && Array.isArray(result.transcription.segments)) {
                const uniqueSegments = result.transcription.segments.filter((segment: TranscriptionSegment, index: number) => {
                  if (!segment.text || !segment.text.trim()) return false;
                  // 检查是否与之前的分段有重复的文本内容
                  const currentText = segment.text.trim();
                  return !(result.transcription as TranscriptionResult).segments!.slice(0, index).some((prevSegment: TranscriptionSegment) =>
                    prevSegment.text && prevSegment.text.trim() === currentText
                  );
                });

                // 使用分段信息创建字幕数据，包含准确的时间信息
                uniqueSegments.forEach((segment: TranscriptionSegment, index: number) => {
                  if (segment.text && segment.text.trim()) {
                    captions[index] = segment.text.trim();
                  }
                });

                // 为音频识别创建准确的captionsData结构，使用Whisper提供的时间信息
                captionsData = {
                  body: uniqueSegments.map((segment: TranscriptionSegment) => ({
                    content: segment.text?.trim() || '',
                    from: segment.start || 0, // 使用Whisper提供的开始时间
                    to: segment.end || 0,     // 使用Whisper提供的结束时间
                    location: 2
                  })).filter((item: { content: string }) => item.content) // 过滤掉空内容
                };
              } 
              console.log('【VideoAdGuard】音频字幕数据已生成', {captions});
            } else {
              console.log('【VideoAdGuard】音频处理和识别失败');
            }
          } catch (error) {
            console.log('【VideoAdGuard】音频识别失败:', error);
            this.adDetectionResult =
              (this.adDetectionResult ? this.adDetectionResult + ' | ' : '') +
              normalizeErrorForUser(error, 'audio');
          }
        } else {
          console.log('【VideoAdGuard】音频识别功能未启用');
        }

        // 如果最终没有获取到任何字幕数据
        if (Object.keys(captions).length === 0) {
          console.log('【VideoAdGuard】当前视频无字幕且无法进行音频识别，无法检测');
          this.adDetectionResult = (this.adDetectionResult ? this.adDetectionResult + ' | ' : '') + '当前视频无字幕，无法检测';
          return;
        }
      }

      // 限制模式处理逻辑
      let rawResult;
      if (isRestrictedMode && hasAdCondition) {
        console.log('【VideoAdGuard】限制模式：检测到可能存在广告，调用大模型进行详细分析...');
        console.log('【VideoAdGuard】限制模式：预提取的商品名称:', good_name);
        const restrictResult = await AIService.detectAdRestricted({
          title: videoInfo.title,
          topComment: topComment,
          additionalMessages: jumpUrlMessages,
          captions: captions,
          goodNames: good_name
        });
        rawResult = restrictResult;
        llmMeta = { provider: restrictResult.provider, model: restrictResult.model };
      } else {
        // 正常模式：使用统一的captions数据进行AI分析
        console.log('【VideoAdGuard】开始AI广告检测分析...');
        const normalResult = await AIService.detectAd({
          title: videoInfo.title,
          topComment: topComment,
          additionalMessages: jumpUrlMessages,
          captions: captions
        });
        rawResult = normalResult;
        llmMeta = { provider: normalResult.provider, model: normalResult.model };
      }

      // 处理可能的转义字符并解析 JSON
      let result;
      try {
        const rawText = rawResult.text;
        const cleanJson = typeof rawText === 'string'
          ? rawText
              .replace(/\/\/.*$/gm, '')    // 删除单行注释 //注释内容
              .replace(/\/\*[\s\S]*?\*\//g, '') // 删除多行注释 /* 注释内容 */
              .replace(/\s+/g, '')     // 删除所有空白字符
              .replace(/\\/g, '')
              .replace(/json/g, '')
              .replace(/```/g, '')
          : JSON.stringify(rawText);

        result = parseAdResult(cleanJson);

        // 验证返回数据格式
        if (typeof result.exist !== 'boolean' || !Array.isArray(result.index_lists)) {
          throw new Error(normalizeErrorForUser('返回数据格式错误', 'detection'));
        }

        // 验证 index_lists 格式
        if (result.exist && !result.index_lists.every((item: number[]) =>
          Array.isArray(item) && item.length === 2 &&
          typeof item[0] === 'number' && typeof item[1] === 'number'
        )) {
          throw new Error(normalizeErrorForUser('广告时间段格式错误', 'detection'));
        }

        console.log('【VideoAdGuard】AI分析完成，检测结果:', result);
      } catch (e) {
        console.warn('【VideoAdGuard】大模型返回数据JSON解析失败:', e);
        throw new Error(normalizeErrorForUser('AI返回数据格式错误', 'detection'));
      }

      if (result.exist) {
        // 过滤掉不合法的索引区间 (end < start)
        this.validIndexLists = result.index_lists.filter((item: number[]) => item[1] >= item[0]);
        // 过滤掉重复的索引区间
        this.validIndexLists = this.validIndexLists.filter((item: number[], index: number, self: number[][]) =>
          index === self.findIndex((t) => t[0] === item[0] && t[1] === item[1])
        );

        // 合并相交、相邻或间隔为1的广告索引区间
        let mergedIndexLists: number[][] = [];
        if (this.validIndexLists.length > 0) {
          const sortedLists = [...this.validIndexLists].sort((a, b) => a[0] - b[0]);
          mergedIndexLists.push([...sortedLists[0]]);
          for (let i = 1; i < sortedLists.length; i++) {
            const currentStart = sortedLists[i][0];
            const currentEnd = sortedLists[i][1];
            const lastMerged = mergedIndexLists[mergedIndexLists.length - 1];
            const lastMergedEnd = lastMerged[1];
            if (currentStart <= lastMergedEnd + 1) {
              lastMerged[1] = Math.max(lastMergedEnd, currentEnd);
            } else {
              mergedIndexLists.push([...sortedLists[i]]);
            }
          }
        }
        const second_lists = this.index2second(mergedIndexLists, captionsData!.body);

        const videoElement = document.querySelector('video');
        const videoDuration = videoElement ? videoElement.duration : 0;

        const isDetectionConfident = isAutoSkipConfident(second_lists, videoDuration);

        await CacheService.saveDetectionResult(bvid, true, result.good_name || [], second_lists, isDetectionConfident, 'local', undefined, llmMeta.model, llmMeta.provider);

        // 异步上传云端缓存（不 await，不阻塞）；低置信度结果不上传，避免不可信的广告区间污染共享缓存
        if (isDetectionConfident) {
          void CloudCacheService.saveRemoteCache(bvid, {
            exist: true,
            goodName: result.good_name || [],
            adTimeRanges: second_lists,
            model: llmMeta.model,
            provider: llmMeta.provider,
            detectedAt: Date.now(),
            isDetectionConfident,
            accuracy: 'accurate',
            source: 'ai',
            version: 1,
          });
        }

        await this.applyDetectionResult(bvid, {
          exist: true,
          goodName: result.good_name || [],
          adTimeRanges: second_lists,
          isDetectionConfident,
        }, 'ai');

      } else {
        console.log('【VideoAdGuard】无广告内容');
        this.removeAutoSkipListener();

        await CacheService.saveDetectionResult(bvid, false, [], [], false);

        // 同步调用 applyDetectionResult 确保反馈按钮被创建
        await this.applyDetectionResult(bvid, {
          exist: false,
          goodName: [],
          adTimeRanges: [],
          isDetectionConfident: false,
        }, 'ai');

        // 异步上传无广告结果到云端
        void CloudCacheService.saveRemoteCache(bvid, {
          exist: false,
          goodName: [],
          adTimeRanges: [],
          model: llmMeta.model,
          provider: llmMeta.provider,
          detectedAt: Date.now(),
          isDetectionConfident: false,
          accuracy: 'accurate',
          source: 'ai',
          version: 1,
        });
      }

    } catch (error) {
      console.warn('【VideoAdGuard】AI分析失败:', error);
      this.adDetectionResult =
        (this.adDetectionResult ? this.adDetectionResult + ' | ' : '') +
        normalizeErrorForUser(error, 'detection');
      this.removeAutoSkipListener();
    }
  }

  // 等待进度条容器加载的方法
  private static waitForProgressWrap(): Element | null {
    // 尝试多个可能的选择器
    const selectors = [
      '.bpx-player-progress-wrap',
      '.bpx-player-progress',
      '.bilibili-player-video-progress-wrap',
      '.bilibili-player-video-progress'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }

    return null;
  }

  // 带重试机制的创建广告标记层方法
  private static createAdMarkersWithRetry(videoElement: HTMLVideoElement, retryCount: number): void {
    const maxRetries = 5;

    if (retryCount >= maxRetries) {
      console.log('【VideoAdGuard】未找到进度条容器，放弃创建广告标记');
      return;
    }

    const progressWrap = this.waitForProgressWrap();
    if (!progressWrap) {
      setTimeout(() => {
        this.createAdMarkersWithRetry(videoElement, retryCount + 1);
      }, 2000); // 每次重试间隔2秒
      return;
    }

    // 找到进度条容器，继续创建标记
    this.createAdMarkersInternal(videoElement, progressWrap);
  }

  // 创建广告标记层的方法
  private static createAdMarkers(videoElement: HTMLVideoElement): void {

    // 清除已有标记层
    this.removeAdMarkers();

    // 获取进度条容器，添加重试机制
    const progressWrap = this.waitForProgressWrap();
    if (!progressWrap) {
      console.log('【VideoAdGuard】未找到进度条容器，尝试延迟创建广告标记');
      // 延迟重试
      setTimeout(() => {
        this.createAdMarkersWithRetry(videoElement, 0);
      }, 1000);
      return;
    }

    // 直接创建标记
    this.createAdMarkersInternal(videoElement, progressWrap);
  }

  /**
   * 内部创建广告标记的实际逻辑 (增强版：支持点击切换、拖动、调整大小)
   */
  private static createAdMarkersInternal(videoElement: HTMLVideoElement, progressWrap: Element): void {
    // 创建广告标记层
    const adMarkerLayer = document.createElement('div');
    adMarkerLayer.className = 'ad-marker-layer10032'; // 添加唯一标识
    adMarkerLayer.style.cssText = `
      position: absolute;
      top: 7px;
      left: 0;
      width: 100%;
      height: 5px;
      pointer-events: none; 
      z-index: 30;
    `;

    // 保存标记层引用
    this.adMarkerLayer = adMarkerLayer;

    // 将广告标记层添加到进度条容器
    progressWrap.appendChild(adMarkerLayer);

    const updateMarkerVisual = (marker: HTMLElement, segment: AdSegment, duration: number) => {
      const startPercent = (segment.start / duration) * 100;
      const endPercent = (segment.end / duration) * 100;
      marker.style.left = `${startPercent}%`;
      marker.style.width = `${endPercent - startPercent}%`;
      marker.style.backgroundColor = segment.active ? '#ff6699' : '#808080'; // 粉色 / 灰色
      marker.style.opacity = segment.active ? '1' : '0.6';
    };

    // 为每个广告位置创建标记
    if (this.adSegments && this.adSegments.length > 0) {
      const duration = videoElement.duration || 1; // 防止除以0

      this.adSegments.forEach((segment) => {
        const marker = document.createElement('div');
        marker.className = 'ad-position-marker10032';
        marker.title = "点击切换跳过状态 | 拖动调整位置 | 边缘调整大小";
        // 初始样式
        marker.style.cssText = `
          position: absolute;
          top: -2px; /* 稍微大一点方便点击 */
          height: 200%; /* 增加点击区域高度 */
          border-radius: 1px;
          cursor: pointer;
          pointer-events: auto; /* 允许交互 */
          transition: background-color 0.2s;
          box-shadow: 0 0 1px rgba(0,0,0,0.5);
          min-width: 4px; /* 最小宽度 */
        `;
        
        // 设置初始位置和颜色
        updateMarkerVisual(marker, segment, duration);

        // 创建调整手柄 (左侧)
        const leftHandle = document.createElement('div');
        leftHandle.style.cssText = `position: absolute; left: -3px; top: 0; width: 6px; height: 100%; cursor: w-resize; z-index: 2;`;
        marker.appendChild(leftHandle);

        // 创建调整手柄 (右侧)
        const rightHandle = document.createElement('div');
        rightHandle.style.cssText = `position: absolute; right: -3px; top: 0; width: 6px; height: 100%; cursor: e-resize; z-index: 2;`;
        marker.appendChild(rightHandle);

        // 交互逻辑变量
        let startX = 0;
        let initialStart = 0;
        let initialEnd = 0;
        let isDragging = false;
        let mode: 'move' | 'resize-left' | 'resize-right' | null = null;

        // 鼠标按下事件
        const onMouseDown = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation(); // 防止触发进度条跳转
          startX = e.clientX;
          initialStart = segment.start;
          initialEnd = segment.end;
          isDragging = false; // 初始假设为点击，如果移动了则改为拖拽

          // 判断点击位置确定模式
          if (e.target === leftHandle) {
            mode = 'resize-left';
          } else if (e.target === rightHandle) {
            mode = 'resize-right';
          } else {
            mode = 'move';
            marker.style.cursor = 'grabbing';
          }

          document.addEventListener('mousemove', onMouseMove);
          document.addEventListener('mouseup', onMouseUp);
        };

        const onMouseMove = (e: MouseEvent) => {
          if (!mode) return;

          const deltaX = e.clientX - startX;
          // 只有移动超过一定距离才视为拖拽
          if (Math.abs(deltaX) > 2) {
            isDragging = true;
          }

          // 计算像素到秒的转换
          const rect = adMarkerLayer.getBoundingClientRect();
          if (rect.width === 0) return;
          const deltaSeconds = (deltaX / rect.width) * duration;

          if (mode === 'move') {
            // 移动：同时改变 start 和 end，保持时长不变
            let newStart = initialStart + deltaSeconds;
            let newEnd = initialEnd + deltaSeconds;
            const len = initialEnd - initialStart;

            // 边界检查
            if (newStart < 0) { newStart = 0; newEnd = len; }
            if (newEnd > duration) { newEnd = duration; newStart = duration - len; }

            segment.start = newStart;
            segment.end = newEnd;

          } else if (mode === 'resize-left') {
            // 左侧调整：改变 start
            let newStart = initialStart + deltaSeconds;
            // 限制：不能小于0，不能大于当前end
            if (newStart < 0) newStart = 0;
            if (newStart > segment.end - 0.5) newStart = segment.end - 0.5; // 保持最小间隔
            segment.start = newStart;

          } else if (mode === 'resize-right') {
            // 右侧调整：改变 end
            let newEnd = initialEnd + deltaSeconds;
            // 限制：不能小于当前start，不能大于duration
            if (newEnd > duration) newEnd = duration;
            if (newEnd < segment.start + 0.5) newEnd = segment.start + 0.5;
            segment.end = newEnd;
          }

          // 实时更新UI
          updateMarkerVisual(marker, segment, duration);
        };

        const onMouseUp = (_e: MouseEvent) => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          marker.style.cursor = 'pointer';

          if (!isDragging) {
            // 如果没有发生拖拽，则视为点击，切换激活状态
            segment.active = !segment.active;
            updateMarkerVisual(marker, segment, duration);
            console.log(`【VideoAdGuard】切换广告段状态: ${segment.active ? '开启' : '关闭'}`);
            // 点击切换状态也视为用户修正
            AdDetector.userModifiedSegments = true;
          } else {
             console.log(`【VideoAdGuard】调整广告段完成: ${this.second2time(segment.start)} - ${this.second2time(segment.end)}`);
             // 标记为用户手动修改
             AdDetector.userModifiedSegments = true;
          }
          
          mode = null;
          // 操作结束后，同步数据到 adTimeRanges，这会立即影响 autoSkip 逻辑
          this.syncAdTimeRanges();
          void this.persistAdSegmentsToCache();
        };

        marker.addEventListener('mousedown', onMouseDown);
        adMarkerLayer.appendChild(marker);
      });
    }

    console.log('【VideoAdGuard】已创建交互式广告标记层');
  }
  
  // 添加：移除广告标记层的方法
  private static removeAdMarkers(): void {
    if (this.adMarkerLayer) {
      this.adMarkerLayer.remove();
      this.adMarkerLayer = null;
    }
    // 同时清理可能存在的其他标记层元素
    document.querySelectorAll('.ad-marker-layer10032').forEach(element => {
      element.remove();
    });
  }

  // 创建跳过提示按钮的方法
  private static createSkipNotification(message: string, rangeKey: string, skippedRanges: Set<string>, adRange: number[]): void {
    // 移除已有的提示
    this.removeSkipNotification();

    // 获取视频元素
    const videoElement = document.querySelector('video') as HTMLVideoElement;
    if (!videoElement) {
      console.warn('【VideoAdGuard】未找到视频元素');
      return;
    }

    // 绑定到视频播放器主容器（整个播放器区域，确保即使进度条未激活也能显示）
    const playerContainer = videoElement.closest('.bpx-player-container') || videoElement.parentElement;
    if (!playerContainer) {
      console.warn('【VideoAdGuard】未找到播放器容器');
      return;
    }

    // 创建提示按钮元素
    const notification = document.createElement('button');
    notification.className = 'skip-notification10032';
    notification.textContent = `${message}`;

    notification.style.cssText = `
      position: absolute;
      right: 24px;
      bottom: 60px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 0 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: bold;
      z-index: 10000;
      border: 2px solid rgba(255, 255, 255, 0.3);
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      white-space: nowrap;
      height: 32px;
      line-height: 32px;
    `;

    // 添加悬停效果
    notification.addEventListener('mouseenter', () => {
      notification.style.background = 'rgba(255, 255, 255, 0.2)';
      notification.style.borderColor = 'rgba(255, 255, 255, 0.6)';
    });

    notification.addEventListener('mouseleave', () => {
      notification.style.background = 'rgba(0, 0, 0, 0.8)';
      notification.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    });

    // 点击事件：根据当前时间和跳过状态判断执行不同操作
    notification.addEventListener('click', () => {
      const currentTime = videoElement.currentTime;
      const [start, end] = adRange;
      const isAlreadySkipped = skippedRanges.has(rangeKey);

      if (!isAlreadySkipped && currentTime < start) {
        // 情况1：广告还未跳过且当前时间在广告开始前，取消跳过这一段广告
        skippedRanges.add(rangeKey);
        console.log(`【VideoAdGuard】用户选择不跳过广告: ${rangeKey}`);
      } else if (isAlreadySkipped && currentTime > end - 1) {
        // 情况2：广告已跳过且当前时间在广告结束前1秒后，跳转到广告区间开头
        videoElement.currentTime = Math.max(start - 1, 0);
        console.log(`【VideoAdGuard】用户选择跳回广告开始位置: ${this.second2time(start)}`);
      } else {
        // 其他情况：取消跳过当前广告
        skippedRanges.add(rangeKey);
        console.log(`【VideoAdGuard】用户选择不跳过当前广告: ${rangeKey}`);
      }

      // 移除提示按钮
      this.removeSkipNotification();
    });

    // 保存引用
    this.skipNotificationElement = notification;

    // 添加到播放器容器
    playerContainer.appendChild(notification);

    // 设置5秒后自动移除（默认显示时间）
    this.skipNotificationTimeout = window.setTimeout(() => {
      this.removeSkipNotification();
    }, 5000);

    console.log('【VideoAdGuard】已创建跳过提示按钮，将在5秒后自动消失');
  }

  // 移除跳过提示的方法
  private static removeSkipNotification(): void {
    // 清理延时器
    if (this.skipNotificationTimeout) {
      clearTimeout(this.skipNotificationTimeout);
      this.skipNotificationTimeout = null;
    }

    if (this.skipNotificationElement) {
      this.skipNotificationElement.remove();
      this.skipNotificationElement = null;
    }
    // 同时清理可能存在的其他提示元素
    document.querySelectorAll('.skip-notification10032').forEach(element => {
      element.remove();
    });
  }



  private static index2second(indexLists: number[][], captions: CaptionItem[]) {
    // 直接生成时间范围列表
    const time_lists = indexLists.map(list => {
      const start = captions[list[0]]?.from || 0;
      const end = captions[list[list.length - 1]]?.to || 0;
      return [start, end];
    });
    return time_lists;
  }

  private static second2time(seconds: number): string {
    const hour = Math.floor(seconds / 3600);
    const min = Math.floor((seconds % 3600) / 60);
    const sec = Math.floor(seconds % 60);
    return `${hour > 0 ? hour + ':' : ''}${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  private static createSkipButton(videoElement: HTMLVideoElement, hasAd: boolean = true) {
    // 移除已有的跳过按钮
    this.removeSkipButton();

    // 绑定到播放器控制栏（进度条上方）
    const controlBar = document.querySelector('.bpx-player-control-bottom');
    if (!controlBar) {
      console.warn("【VideoAdGuard】未找到播放器控制栏");
      return;
    };

    // 创建按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'button-container10032';
    buttonContainer.style.cssText = `
      position: absolute;
      right: 12px;
      bottom: 100%;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 10000;
    `;

    // 创建跳过按钮
    const skipButton = document.createElement('button');
    skipButton.className = 'skip-ad-button10032';
    skipButton.textContent = '跳过广告';
    skipButton.style.cssText = `
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 0 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: bold;
      border: 2px solid rgba(255, 255, 255, 0.3);
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      white-space: nowrap;
      height: 32px;
      line-height: 32px;
    `;

    // 添加悬停效果
    skipButton.addEventListener('mouseenter', () => {
      skipButton.style.background = 'rgba(255, 255, 255, 0.2)';
      skipButton.style.borderColor = 'rgba(255, 255, 255, 0.6)';
    });

    skipButton.addEventListener('mouseleave', () => {
      skipButton.style.background = 'rgba(0, 0, 0, 0.8)';
      skipButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    });

    // 保存引用
    if (hasAd) {
      this.skipButtonElement = skipButton;
    }

    // 创建反馈按钮（与跳过按钮样式一致，正方形）
    const feedbackButton = document.createElement('button');
    feedbackButton.className = 'feedback-button10032';
    feedbackButton.title = '点击反馈此检测结果不准确';
    feedbackButton.innerHTML = '&#x2717;'; // ✗ 符号
    feedbackButton.style.cssText = `
      background: rgba(0, 0, 0, 0.8);
      color: rgba(255, 255, 255, 0.7);
      width: 32px;
      height: 32px;
      border-radius: 6px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      cursor: pointer;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    `;

    feedbackButton.addEventListener('mouseenter', () => {
      feedbackButton.style.background = 'rgba(255, 100, 100, 0.8)';
      feedbackButton.style.color = 'white';
      feedbackButton.style.borderColor = 'rgba(255, 255, 255, 0.6)';
    });

    feedbackButton.addEventListener('mouseleave', () => {
      feedbackButton.style.background = 'rgba(0, 0, 0, 0.8)';
      feedbackButton.style.color = 'rgba(255, 255, 255, 0.7)';
      feedbackButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
    });

    feedbackButton.addEventListener('click', async () => {
      const bvid = this.getBvidFromUrl();
      if (bvid) {
        // 检查用户是否手动调整过广告区间
        const isUserModified = this.userModifiedSegments;

        // 获取本地缓存以发送完整的云端数据
        const cachedRecord = await CacheService.getDetectionResult(bvid);

        // 直接使用本地缓存的 recordSource 作为云端的 source
        const source = cachedRecord?.recordSource || (this.userModifiedSegments ? 'user' : 'ai');

        const success = await CloudCacheService.saveRemoteCache(bvid, {
          exist: cachedRecord?.exist ?? this.adTimeRanges.length > 0,
          goodName: cachedRecord?.goodName || [],
          adTimeRanges: this.adTimeRanges,
          model: cachedRecord?.model || 'unknown',
          provider: cachedRecord?.provider || 'unknown',
          detectedAt: cachedRecord?.detectedAt || Date.now(),
          isDetectionConfident: cachedRecord?.isDetectionConfident ?? false,
          accuracy: isUserModified ? 'accurate' : 'inaccurate',
          source,
          version: 1,
        });

        if (success) {
          if (!isUserModified) {
            // 仅在非用户修正情况下标记本地缓存为不准确
            await CacheService.markAsInaccurate(bvid);
          }
          feedbackButton.textContent = isUserModified ? '✓ 已提交修正' : '✓ 反馈成功';
          feedbackButton.style.background = 'rgba(100, 200, 100, 0.9)';
          feedbackButton.style.color = 'white';
          feedbackButton.style.borderColor = 'rgba(255, 255, 255, 0.8)';
          feedbackButton.style.width = 'auto';
          feedbackButton.style.padding = '0 12px';
          setTimeout(() => {
            feedbackButton.textContent = '';
            feedbackButton.innerHTML = '&#x2717;';
            feedbackButton.style.background = 'rgba(0, 0, 0, 0.8)';
            feedbackButton.style.color = 'rgba(255, 255, 255, 0.7)';
            feedbackButton.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            feedbackButton.style.width = '32px';
            feedbackButton.style.padding = '0';
          }, 2000);
        }
      }
    });

    // 保存反馈按钮引用
    this.feedbackButtonElement = feedbackButton;

    // 按顺序添加按钮（跳过按钮在左，反馈按钮在右）
    if (hasAd) {
      buttonContainer.appendChild(skipButton);
    }
    buttonContainer.appendChild(feedbackButton);
    controlBar.appendChild(buttonContainer);

    // 点击跳过按钮
    if (hasAd) {
      skipButton.addEventListener('click', () => {
        const currentTime = videoElement.currentTime;
        console.log('【VideoAdGuard】当前时间:', currentTime);
        // 查找当前是否在某个活跃广告段内
        const adSegment = this.adTimeRanges.find(([start, end]) =>
          currentTime >= Math.max(start-10,0) && currentTime < end
        );

        if (adSegment) {
          videoElement.currentTime = adSegment[1]; // 跳到广告段结束时间
          console.log('【VideoAdGuard】跳转时间:',adSegment[1]);
        }
      });
    }

    console.log('【VideoAdGuard】已创建跳过按钮');
  }

  // 移除跳过按钮的方法
  private static removeSkipButton(): void {
    if (this.skipButtonElement) {
      this.skipButtonElement.remove();
      this.skipButtonElement = null;
    }
    if (this.feedbackButtonElement) {
      this.feedbackButtonElement = null;
    }
    // 同时清理可能存在的其他跳过按钮元素
    document.querySelectorAll('.skip-ad-button10032').forEach(element => {
      element.remove();
    });
    // 清理按钮容器
    document.querySelectorAll('.button-container10032').forEach(element => {
      element.remove();
    });
  }

  // 设置自动跳过监听器的方法
  private static setupAutoSkip(videoElement: HTMLVideoElement) {
    // 确保移除旧监听器
    this.removeAutoSkipListener();

    // 用于记录已经跳过的广告区间和已显示提示的区间
    const skippedRanges = new Set<string>();
    const notifiedRanges = new Set<string>();
    let lastCheckTime = 0

    // 定义并保存 timeupdate 回调
    this.timeUpdateListener = () => {
      // 添加节流，每秒最多执行一次
      const now = Date.now();
      if (now - lastCheckTime >= 1000) {
        lastCheckTime = now;
        const currentTime = videoElement.currentTime;

        // 注意：adTimeRanges 现在是动态更新的，仅包含 active=true 的段
        for (const [start, end] of this.adTimeRanges) {
          // 生成当前区间的唯一标识 (使用时间组合，虽然可能变化，但在跳跃瞬间是稳定的)
          const rangeKey = `${start}-${end}`;

          // 检查是否即将进入广告区间（前3秒）
          const timeToAdStart = start - currentTime;
          if (timeToAdStart > 0 && timeToAdStart <= 3 && !notifiedRanges.has(rangeKey)) {
            // 显示即将跳过的提示按钮
            const message = `即将跳过广告 (点击取消跳过)`;
            this.createSkipNotification(message, rangeKey, skippedRanges, [start, end]);
            notifiedRanges.add(rangeKey);
          }

          // 如果当前时间在广告区间内，且该区间还未被跳过
          if (currentTime >= start && currentTime < end && !skippedRanges.has(rangeKey)) {
              console.log(`【VideoAdGuard】检测到广告时间 ${this.second2time(start)}~${this.second2time(end)}，当前时间 (${currentTime}s)，准备跳过...`);

              // 目标时间略微超过广告结束时间，防止误差，并确保不超出视频总长
              const targetTime = Math.min(end + 0.1, videoElement.duration);
              videoElement.currentTime = targetTime;
              console.log(`【VideoAdGuard】已自动跳过到 ${this.second2time(targetTime)}`);

              // 将当前区间标记为已跳过
              skippedRanges.add(rangeKey);

              // 检查是否所有区间都已经跳过
              // 注意：如果用户动态开启了新区间，这个判断会在下一次循环中处理
              break;
          }
        }
      }
    };

    // 添加事件监听
    videoElement.addEventListener('timeupdate', this.timeUpdateListener);
    console.log("【VideoAdGuard】已添加 timeupdate 监听器用于自动跳过");
  }

  // 移除自动跳过监听器的方法
  private static removeAutoSkipListener() {
    const videoElement = document.querySelector('video');
    if (videoElement && this.timeUpdateListener) {
      videoElement.removeEventListener('timeupdate', this.timeUpdateListener);
      console.log("【VideoAdGuard】已移除 timeupdate 监听器");
      this.timeUpdateListener = null;
    }
  }
}

/**
 * AI 感评分检测器：拉取字幕抽样（连同标题简介）交给 LLM 按 AI_SCRIPT_CRITERIA 评分，
 * 在视频信息行末尾显示「AI 感 xx/100」角标。
 * 与广告检测相互独立：评分失败不影响广告检测。
 * 判断通道跟随设置中的服务商——System One 走真概率阈值组合，其余走 prompt 整数评分。
 */
class AIScriptDetector {
  private static badgeElement: HTMLElement | null = null;

  public static async analyze() {
    try {
      const settings = await chrome.storage.local.get(['enableExtension']);
      if (settings.enableExtension === false) return;

      const bvid = AdDetector.getBvidFromUrl();

      // 三层查找与广告检测一致：本地缓存 → 云端缓存 → AI 检测
      const cached = await AiScriptCacheService.get(bvid);
      if (cached) {
        console.log('【VideoAdGuard】AI 感评分：使用本地缓存');
        this.showBadge(cached.aiScore, cached.provider, cached.model, 'local');
        return;
      }

      const remote = await CloudCacheService.fetchRemoteAIScript(bvid);
      if (remote) {
        console.log('【VideoAdGuard】AI 感评分：使用云端缓存');
        await AiScriptCacheService.save(bvid, {
          aiScore: remote.aiScore,
          criteriaVersion: remote.criteriaVersion,
          model: remote.model,
          provider: remote.provider,
          detectedAt: remote.detectedAt,
          source: 'remote',
        });
        this.showBadge(remote.aiScore, remote.provider, remote.model, 'remote');
        return;
      }

      const videoInfo = await BilibiliService.getVideoInfo(bvid);
      const playerInfo = await BilibiliService.getPlayerInfo(bvid, videoInfo.cid);

      if (!playerInfo.subtitle?.subtitles?.length) {
        console.log('【VideoAdGuard】AI 感评分：视频无字幕，跳过');
        return;
      }

      const captionsUrl = 'https:' + playerInfo.subtitle.subtitles[0].subtitle_url;
      const captionsData = await BilibiliService.getCaptions(captionsUrl);
      const captions: Record<number, string> = {};
      captionsData.body.forEach((caption: CaptionItem, index: number) => {
        captions[index] = caption.content;
      });

      const sample = sampleScriptText(captions);
      if (!sample) {
        console.log('【VideoAdGuard】AI 感评分：字幕内容为空，跳过');
        return;
      }

      console.log('【VideoAdGuard】开始 AI 感评分（标题+简介+字幕抽样）');
      const result = await AIService.detectAIScript({
        title: videoInfo.title,
        description: videoInfo.desc || '',
        sample,
      });

      const score = parseAiStyleScore(result.text);
      if (score === null) throw new Error(normalizeErrorForUser('AI 感评分返回数据格式错误', 'detection'));

      const record = {
        aiScore: score,
        criteriaVersion: AI_SCRIPT_CRITERIA_VERSION,
        model: result.model,
        provider: result.provider,
        detectedAt: Date.now(),
        source: 'local' as const,
      };
      await AiScriptCacheService.save(bvid, record);

      // 异步上传云端共享（不 await，不阻塞显示）
      void CloudCacheService.saveRemoteAIScript(bvid, {
        aiScore: record.aiScore,
        criteriaVersion: record.criteriaVersion,
        model: record.model,
        provider: record.provider,
        detectedAt: record.detectedAt,
      });

      console.log('【VideoAdGuard】AI 感评分结果:', { score, provider: result.provider, model: result.model });
      this.showBadge(score, record.provider, record.model, 'ai');
    } catch (error) {
      console.warn('【VideoAdGuard】AI 感评分失败:', error);
      this.removeBadge();
    }
  }

  /** 在视频信息行（播放量/弹幕/日期）末尾插入角标，未渲染时延迟重试 */
  private static showBadge(score: number, provider: string, model: string, source: 'local' | 'remote' | 'ai', retryCount = 0): void {
    const detailList = document.querySelector('.video-info-detail-list.video-info-detail-content');

    if (!detailList) {
      if (retryCount >= 5) {
        console.log('【VideoAdGuard】未找到视频信息行容器，放弃显示 AI 感角标');
        return;
      }
      setTimeout(() => this.showBadge(score, provider, model, source, retryCount + 1), 1000);
      return;
    }

    this.removeBadge();
    // 分数分级配色：高→B站粉，中→橙，低→灰
    const color = score >= 70 ? '#f25d8e' : score >= 40 ? '#ff7f24' : '#9499a0';
    const sourceLabel = source === 'local' ? '本地缓存' : source === 'remote' ? '云端共享' : 'AI 检测';

    const badge = document.createElement('span');
    badge.className = 'ai-script-badge10032';
    badge.textContent = `AI 感 ${score}/100`;
    badge.title = `AI 风格评分 ${score}/100（模式化、冗余、抽象化等特征强度）\n来源: ${provider} / ${model}（${sourceLabel}）`;
    badge.style.cssText = `
      display: inline-flex;
      align-items: center;
      align-self: center;
      padding: 2px 8px;
      margin-left: 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      color: ${color};
      background: ${color}1a;
      border: 1px solid ${color}55;
    `;
    detailList.appendChild(badge);
    this.badgeElement = badge;
  }

  private static removeBadge(): void {
    this.badgeElement?.remove();
    this.badgeElement = null;
    document.querySelectorAll('.ai-script-badge10032').forEach((element) => element.remove());
  }
}

// 消息监听器：
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type === 'GET_AD_INFO') {
    let bvid: string | null = null;
    try {
      bvid = AdDetector.getBvidFromUrl();
    } catch {
      bvid = null;
    }
    sendResponse({
      adInfo: AdDetector.adDetectionResult || '广告检测尚未完成',
      adTimeRanges: AdDetector.getAdTimeRanges(),
      userModified: AdDetector.getUserModifiedSegments(),
      bvid,
      timestamp: Date.now()
    });
  }
});

// 页面加载监听：视频页跑广告/AI感评分，视频入口页（首页/热门/搜索/动态等）启动卡片标注
window.addEventListener('load', () => {
  if (isBilibiliVideoPage(location.href)) {
    AdDetector.analyze();
    AIScriptDetector.analyze();
  } else if (getVideoCardScenarios(location.href).length > 0) {
    VideoCardAnnotator.start();
  }
});

// 添加 URL 变化监听
let lastUrl = location.href;


new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    const currentBvid = isBilibiliVideoPage(url) ? AdDetector.getBvidFromUrl(url) : null;
    const previousBvid = isBilibiliVideoPage(lastUrl) ? AdDetector.getBvidFromUrl(lastUrl) : null;

    lastUrl = url;

    // 只有当BV号发生变化时才触发检测逻辑
    if (currentBvid && currentBvid !== previousBvid) {
      console.log('【VideoAdGuard】URL changed with different BV:', url, 'Previous BV:', previousBvid, 'Current BV:', currentBvid);
      AdDetector.analyze();
      AIScriptDetector.analyze();
    } else {
      console.log('【VideoAdGuard】URL changed but BV unchanged, skipping detection:', url);
    }
  }
}).observe(document, { subtree: true, childList: true });
