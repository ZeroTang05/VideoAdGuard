/**
 * 字幕文案抽样：控制发给 LLM 的文本长度，节省 token。
 * 短文案全量发送；长文案取开头 / 中段 / 结尾三段，用省略号连接。
 */

export interface ScriptSampleOptions {
  /** 每段抽样的目标字符数 */
  segmentTarget: number;
  /** 全文不超过该长度时直接全量发送 */
  maxTotal: number;
}

export const DEFAULT_SAMPLE_OPTIONS: ScriptSampleOptions = {
  segmentTarget: 600,
  maxTotal: 2000,
};

/**
 * 按字幕索引顺序拼接全文并抽样。
 * @param captions 字幕索引到文本的映射（与广告检测共用的数据结构）
 * @param options 抽样参数，默认每段 600 字、全文 2000 字以内不抽样
 * @returns 抽样后的文案文本；无有效字幕时返回空字符串
 */
export function sampleScriptText(
  captions: Record<number, string>,
  options: Partial<ScriptSampleOptions> = {}
): string {
  const { segmentTarget, maxTotal } = { ...DEFAULT_SAMPLE_OPTIONS, ...options };

  const fullText = Object.keys(captions)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => captions[index])
    .filter((text) => typeof text === 'string' && text.trim())
    // B 站 AI 字幕通常无标点，分条对应语音停顿，条间补空格恢复断句线索
    .join(' ');

  if (fullText.length <= maxTotal) return fullText;

  // 三段抽样：开头、中段、结尾，各取 segmentTarget 字符
  const middleStart = Math.floor((fullText.length - segmentTarget) / 2);
  const segments = [
    fullText.slice(0, segmentTarget),
    fullText.slice(middleStart, middleStart + segmentTarget),
    fullText.slice(fullText.length - segmentTarget),
  ];
  return segments.join('\n……\n');
}
