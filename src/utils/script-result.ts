/**
 * AI 感评分结果的解析与清洗。
 * 评分器被要求仅输出 0~100 整数，这里对模型的跑偏输出做容错提取。
 */

/**
 * 从评分器回复中提取 0~100 的整数分数。
 * @param raw LLM 原始回复（理想为 "87"；可能带说明文字、Markdown 或思考残留）
 * @returns 分数；提取不到合法整数返回 null
 */
export function parseAiStyleScore(raw: string): number | null {
  if (!raw || typeof raw !== 'string') return null;

  const text = raw.trim();

  // 理想情况：整体就是一个整数
  const direct = Number.parseInt(text, 10);
  if (Number.isInteger(direct) && String(direct) === text && direct >= 0 && direct <= 100) {
    return direct;
  }

  // 容错一：取「分数/评分/score」关键词后的第一个 0~100 整数（如 "最终分数：87"）
  const keywordMatch = text.match(/(?:分数|评分|score)\s*[:：是为]?\s*(\d{1,3})/i);
  if (keywordMatch) {
    const value = Number.parseInt(keywordMatch[1], 10);
    if (value >= 0 && value <= 100) return value;
  }

  // 容错二：取最后一个 0~100 整数（评分器通常把分数放在输出末尾；
  // 带负号的数字如维度等级 "-1" 会被 0~100 过滤自然跳过）
  const matches = text.match(/-?\d+/g) || [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const value = Number.parseInt(matches[i], 10);
    if (value >= 0 && value <= 100) return value;
  }

  return null;
}

/** 视频页与列表卡片共用人工标注的显示文字。 */
export function aiScriptLabelText(isAiScript: boolean): string {
  return isAiScript ? '疑似 AI 文案' : '非 AI 文案';
}
