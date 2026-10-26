import { normalizeErrorForUser } from '../utils/errors';
import { NORMAL_AD_RULES } from './ad-rules';
import { LLMInvokePayload, LLMInvokeResult, LLMResponseFormat, LLMTask } from './llm/types';

interface VideoInfo {
  title: string;
  topComment: string | null;
  additionalMessages: Record<string, Record<string, unknown>> | null;
  captions: Record<number, string>;
}

interface RestrictedVideoInfo extends VideoInfo {
  goodNames?: string[];
}

interface LLMInvokeResponse {
  success: boolean;
  data?: LLMInvokeResult;
  error?: string;
}

export class AIService {
  private static async invokeModel(
    systemPrompt: string,
    userPrompt: string,
    responseFormat: LLMResponseFormat,
    maxTokens: number = 8192,
    task?: LLMTask
  ): Promise<{ text: string; provider: string; model: string }> {
    const payload: LLMInvokePayload = {
      systemPrompt,
      userPrompt,
      responseFormat,
      maxTokens,
      task,
    };

    const response = (await chrome.runtime.sendMessage({
      type: 'LLM_INVOKE',
      payload,
    }).catch(e => {
      throw new Error(normalizeErrorForUser(e, 'llm'));
    })) as LLMInvokeResponse;

    if (!response?.success) {
      throw new Error(normalizeErrorForUser(response?.error, 'llm'));
    }

    const text = response?.data?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(normalizeErrorForUser('未返回文本内容', 'llm'));
    }

    return {
      text: text.trim(),
      provider: response?.data?.provider || 'unknown',
      model: response?.data?.model || 'unknown',
    };
  }

  public static async detectAd(videoInfo: VideoInfo): Promise<{ text: string; provider: string; model: string }> {
    return this.invokeModel(
      `你是一个专业的视频内容分析师，专门识别视频中的植入广告。${NORMAL_AD_RULES}`,
      this.buildPrompt(videoInfo),
      'json',
      8192,
      { kind: 'detect_ad', videoInfo, restricted: false }
    );
  }

  public static async detectAdRestricted(videoInfo: RestrictedVideoInfo): Promise<{ text: string; provider: string; model: string }> {
    return this.invokeModel(
      '你是一个专业的视频内容分析师，专门识别视频中的植入广告。在限制模式下，你需要更加谨慎和精确地判断广告内容。只有当内容明确包含商业推广、产品推荐且有明确的购买引导时，才认定为广告。',
      this.buildRestrictedPrompt(videoInfo),
      'json',
      8192,
      { kind: 'detect_ad', videoInfo, restricted: true }
    );
  }

  private static buildPrompt(videoInfo: VideoInfo): string {
    const prompt = `你需要分析视频内容，识别其中的植入广告。

视频信息：
标题：${videoInfo.title}
置顶评论：${videoInfo.topComment || '无'}
附加信息：${JSON.stringify(videoInfo.additionalMessages) || '无'}

检测规则：
${NORMAL_AD_RULES}

字幕内容：${JSON.stringify(videoInfo.captions)}

请严格按照检测规则进行判断，以json格式输出（无注释）：
{
  "exist": <bool. true表示存在广告，false表示不存在广告>,
  "good_name": <list[string]. 广告的商品、品牌、平台或服务名称>,
  "index_lists": <list[list[int]]. 二维数组，每一行是[start, end]，表示一段完整广告的开头结尾字幕index，包含推广引入，截止于恢复正文之前>
}`;
    console.log('【VideoAdGuard】构建提示词成功:', { prompt });
    return prompt;
  }

  private static buildRestrictedPrompt(videoInfo: RestrictedVideoInfo): string {
    const goodNamesText =
      videoInfo.goodNames && videoInfo.goodNames.length > 0 ? videoInfo.goodNames.join('、') : '无';

    const prompt = `你需要分析视频内容，识别其中的植入广告。

视频信息：
标题：${videoInfo.title}
置顶评论：${videoInfo.topComment || '无'}
附加信息：${JSON.stringify(videoInfo.additionalMessages) || '无'}

限制模式检测规则：
1. 只有当内容明确包含商业推广、产品推荐且有明确的购买引导时，才认定为广告
2. 纯粹的产品介绍、评测、对比，如果没有明确的购买引导，不认定为广告
3. 如果置顶评论中没有商品链接，则更倾向于认定为无广告
4. 广告内容必须与置顶评论或附加信息中的链接标题相对应
5. 一段广告的检测需要完整：包含商品介绍前的转折性引入，介绍商品的特点、优势、适用场景、价格、购买渠道等信息，以及商品介绍后的引导购买部分
6. 重点关注预提取的商品名称，仅在字幕中寻找与这些商品相关的广告内容

预提取的商品名称：${goodNamesText}
字幕内容：${JSON.stringify(videoInfo.captions)}

请严格按照限制模式规则进行判断，特别关注预提取的商品名称，以json格式输出（无注释）：
{
  "exist": <bool. true表示存在广告，false表示不存在广告>,
  "good_name": <list[string]. 广告的商品名称，注意仅返回字幕中存在且与预提取的商品名称相关的商品>,
  "index_lists": <list[list[int]]. 二维数组，每一行是[start, end]，表示一段*完整*广告的开头结尾字幕index，包含商品介绍前的引入和结尾后的推荐性、煽动购买的语言>
}`;
    console.log('【VideoAdGuard】限制模式构建提示词成功:', { prompt });
    return prompt;
  }

  public static async extractProductName(linkTitle: string, sourceTitle: string = linkTitle): Promise<string> {
    const systemPrompt =
      '你是商品名称提取专家。从链接标题中提取核心商品名称，去除修饰词、营销词汇，只保留商品的本质名称。';
    const userPrompt = `链接标题：${linkTitle}\n\n请提取其中的核心商品名称，只返回纯文本的商品名称，不要解释。`;
    const result = await this.invokeModel(systemPrompt, userPrompt, 'text', 120, {
      kind: 'product_name', linkTitle: sourceTitle,
    });
    return result.text
      .replace(/^```[\w-]*\s*/i, '')
      .replace(/```$/i, '')
      .trim()
      .replace(/^["'`]/, '')
      .replace(/["'`]$/, '')
      .trim();
  }
}
