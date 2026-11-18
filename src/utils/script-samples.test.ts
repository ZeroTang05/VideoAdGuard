import { describe, expect, it } from 'vitest';
import { DEFAULT_SAMPLE_OPTIONS, sampleScriptText } from './script-samples';

describe('字幕文案抽样', () => {
  it('空字幕和无有效文本时返回空字符串', () => {
    expect(sampleScriptText({})).toBe('');
    expect(sampleScriptText({ 0: '  ', 1: '' })).toBe('');
  });

  it('按索引顺序拼接，条间补空格恢复断句', () => {
    expect(sampleScriptText({ 10: '结尾', 2: '中段', 0: '开头' })).toBe('开头 中段 结尾');
  });

  it('短文案全量返回，不做抽样', () => {
    const captions = { 0: '你好'.repeat(100) }; // 200 字，低于默认阈值
    expect(sampleScriptText(captions)).toBe('你好'.repeat(100));
  });

  it('长文案取三段并保留开头结尾', () => {
    const head = '开'.repeat(DEFAULT_SAMPLE_OPTIONS.segmentTarget);
    const tail = '尾'.repeat(DEFAULT_SAMPLE_OPTIONS.segmentTarget);
    const captions = { 0: head + '中'.repeat(3000) + tail };
    const sampled = sampleScriptText(captions);

    expect(sampled.startsWith('开')).toBe(true);
    expect(sampled.endsWith('尾')).toBe(true);
    expect(sampled).toContain('\n……\n');
    // 三段 + 两个省略号连接符，长度受控
    const expectedLength = DEFAULT_SAMPLE_OPTIONS.segmentTarget * 3 + 2 * '\n……\n'.length;
    expect(sampled.length).toBe(expectedLength);
  });

  it('中段抽样覆盖全文中部位置', () => {
    const captions = { 0: '甲'.repeat(5000) + '乙'.repeat(5000) }; // 中点在乙的起点附近
    const sampled = sampleScriptText(captions);
    const segments = sampled.split('\n……\n');
    // 5000 字处已进入乙区，中段应包含乙
    expect(segments[1]).toContain('乙');
    expect(segments[0]).not.toContain('乙');
  });
});
