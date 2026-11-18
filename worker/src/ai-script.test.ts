/** 验证 AI 感评分保存请求的字段校验。 */
import { describe, expect, it } from 'vitest';
import { validateAiScriptBody } from './index';

const validBody = {
  bvid: 'BV1xx411c7mD',
  aiScore: 87,
  criteriaVersion: 2,
  model: 'deepseek-chat',
  provider: 'openai',
  detectedAt: Date.now(),
  clientVersion: '1.4.3',
};

describe('validateAiScriptBody', () => {
  it('接受合法请求并保留全部字段', () => {
    const result = validateAiScriptBody(validBody);
    expect(result).not.toBeNull();
    expect(result?.bvid).toBe('BV1xx411c7mD');
    expect(result?.aiScore).toBe(87);
    expect(result?.criteriaVersion).toBe(2);
  });

  it('criteriaVersion 可选，非法值忽略', () => {
    expect(validateAiScriptBody({ ...validBody, criteriaVersion: undefined })?.criteriaVersion).toBeUndefined();
    expect(validateAiScriptBody({ ...validBody, criteriaVersion: 2.5 } as Record<string, unknown>)?.criteriaVersion).toBeUndefined();
  });

  it('接受 0 和 100 的边界分数', () => {
    expect(validateAiScriptBody({ ...validBody, aiScore: 0 })?.aiScore).toBe(0);
    expect(validateAiScriptBody({ ...validBody, aiScore: 100 })?.aiScore).toBe(100);
  });

  it('拒绝非法 BV 号、越界或非整数分数', () => {
    expect(validateAiScriptBody({ ...validBody, bvid: 'av170001' })).toBeNull();
    expect(validateAiScriptBody({ ...validBody, aiScore: -1 })).toBeNull();
    expect(validateAiScriptBody({ ...validBody, aiScore: 101 })).toBeNull();
    expect(validateAiScriptBody({ ...validBody, aiScore: 87.5 })).toBeNull();
    expect(validateAiScriptBody({ ...validBody, aiScore: 'high' })).toBeNull();
    expect(validateAiScriptBody({ ...validBody, aiScore: undefined })).toBeNull();
  });

  it('拒绝未来时间戳超过一天的 detectedAt', () => {
    expect(validateAiScriptBody({ ...validBody, detectedAt: Date.now() + 2 * 86400000 })).toBeNull();
  });

  it('缺失的可选字段使用默认值', () => {
    const result = validateAiScriptBody({
      bvid: 'BV1xx411c7mD',
      aiScore: 34,
    });
    expect(result?.model).toBe('unknown');
    expect(result?.provider).toBe('unknown');
    expect(result?.clientVersion).toBe('');
  });
});
