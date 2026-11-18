import { describe, expect, it } from 'vitest';
import { parseAiStyleScore } from './script-result';

describe('parseAiStyleScore 解析 AI 感分数', () => {
  it('解析裸整数（理想输出）', () => {
    expect(parseAiStyleScore('87')).toBe(87);
    expect(parseAiStyleScore(' 0 ')).toBe(0);
    expect(parseAiStyleScore('100')).toBe(100);
  });

  it('从说明文字中提取第一个 0~100 的整数', () => {
    expect(parseAiStyleScore('最终分数：87')).toBe(87);
    expect(parseAiStyleScore('根据规则，评分为 **62** 分')).toBe(62);
    expect(parseAiStyleScore('AI 感分数是 45。')).toBe(45);
  });

  it('跳过范围外的数字，取第一个合法值', () => {
    // 405 超出范围（如误输出的字数），87 在范围内
    expect(parseAiStyleScore('文本长度 405，分数 87')).toBe(87);
  });

  it('带负号的数字不匹配，避免维度等级误当分数', () => {
    // score 关键词后跟 34，优先命中；D1 的 1 和 -1 都不会干扰
    expect(parseAiStyleScore('D1 = -1, score 34')).toBe(34);
    // 无关键词时取最后一个合法整数（评分器习惯把分数放末尾）
    expect(parseAiStyleScore('D1 2 D2 3 最终 34')).toBe(34);
  });

  it('无法提取时返回 null', () => {
    expect(parseAiStyleScore('')).toBeNull();
    expect(parseAiStyleScore('无法评分')).toBeNull();
    expect(parseAiStyleScore('405')).toBeNull(); // 唯一数字超出 0~100
    expect(parseAiStyleScore('120 150')).toBeNull();
  });
});
