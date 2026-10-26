/** 验证完整字幕的单次请求、区间合并与非法答案。 */
import { describe, expect, it } from 'vitest';
import { buildApiUrl, resolveLLMSettings } from './config';
import { buildAdRequest, mergeAdIndices, readAdProbability, selectAdIndices } from './system-one';
import { NORMAL_AD_RULES } from '../ad-rules';
import type { NoulResponse } from '@typesafe-ai/sdk';
import type { AdVideoInfo } from './types';
import { findSystemOnePreset, getSystemOneSdkBaseUrl, SYSTEM_ONE_PRESETS } from './system-one-presets';
import { normalizeErrorForUser } from '../../utils/errors';
import transcriptProbabilities from '../../../test/fixtures/jev-transcript-probabilities.json';

const video: AdVideoInfo = {
  title: '视频标题', topComment: '商品链接', additionalMessages: null,
  captions: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [index, `字幕 ${index}`])),
};

describe('Jev 广告检测', () => {
  it('将全部字幕及问题放入同一个请求，并保留完整上下文', () => {
    const { request, indices } = buildAdRequest(video, false, 'jev-latest');
    expect(indices).toEqual(Array.from({ length: 70 }, (_, i) => i));
    const state = JSON.parse(request.state as string);
    expect(state.captions).toEqual(video.captions);
    expect(Object.keys(request.questions)).toHaveLength(70);
    expect(request.questions.caption_32.instructions).toContain('captions[32]');
    expect(request.questions.caption_69.instructions).toContain('captions[69]');
  });

  it('保留稀疏字幕的原始索引，并传递限制模式与商品信息', () => {
    const batch = buildAdRequest({ ...video, captions: { 15: '推广', 3: '正常内容' }, goodNames: ['商品甲'] }, true, 'jev-latest');
    expect(batch.indices).toEqual([3, 15]);
    expect(JSON.parse(batch.request.state as string).detectionRules).toContain('限制模式');
    expect(batch.request.questions.product_0.instructions).toContain('products[0]');
    expect(JSON.parse(batch.request.state as string).products).toEqual(['商品甲']);
  });

  it('检测规则只存一次，所有字幕问题保持简短且省略重复 criteria', () => {
    const { request } = buildAdRequest(video, false, 'jev-latest');
    expect(JSON.parse(request.state as string).detectionRules).toBe(NORMAL_AD_RULES);
    for (const question of Object.values(request.questions)) {
      expect(question.criteria).toBeUndefined();
      expect(String(question.instructions).length).toBeLessThan(45);
    }
  });

  it('保留所有字幕与商品证据，移除链接地址等重复元数据', () => {
    const source = {
      ...video,
      additionalMessages: { 'https://example.com/product': { '链接标题': '商品甲', '平台名称': '店铺', '是否为官方商品链接': true } },
      goodNames: ['商品甲'],
    };
    const { request } = buildAdRequest(source, true, 'jev-latest');
    const state = JSON.parse(request.state as string);
    expect(state.captions).toEqual(video.captions);
    expect(state.products).toEqual(['商品甲']);
    expect(state.links).toEqual([{ title: '商品甲', platform: '店铺', officialProduct: true }]);
    expect(request.state).not.toContain('https://example.com/product');
  });

  it('将 OpenCode 的真实超限错误显示为输入内容过长', () => {
    const error = new Error('400 {"detail":{"error_type":"max_tokens_exceeded"}}');
    expect(normalizeErrorForUser(error, 'llm')).toBe('输入内容过长，请减少内容后重试');
  });

  it('合并连续广告字幕，同时保留中间的正常字幕', () => {
    expect(mergeAdIndices([33, 31, 32, 31, 2, 4])).toEqual([[2, 2], [4, 4], [31, 33]]);
    expect(mergeAdIndices([])).toEqual([]);
  });

  it('拒绝缺失与非法概率，不把失败视为无广告', () => {
    expect(readAdProbability({ a: { type: 'noul', noul: 0.8 } }, 'a')).toBe(0.8);
    expect(() => readAdProbability({}, 'a')).toThrow('缺少有效概率');
    for (const noul of [NaN, Infinity, -0.1, 1.1]) {
      expect(() => readAdProbability({ a: { type: 'noul', noul } }, 'a')).toThrow('缺少有效概率');
    }
  });

  it('拒绝空字幕', () => {
    expect(() => buildAdRequest({ ...video, captions: {} }, false, 'jev-latest')).toThrow('字幕为空');
  });

  it('根地址、v1 地址与完整端点都解析到同一个接口', () => {
    for (const baseUrl of ['https://api.typesafe.ai', 'https://api.typesafe.ai/v1', 'https://api.typesafe.ai/v1/systemone/']) {
      const settings = resolveLLMSettings({ provider: 'system_one', baseUrl, model: 'jev-latest' });
      expect(settings.apiUrl).toBe('https://api.typesafe.ai/v1/systemone');
    }
    expect(buildApiUrl('openai', 'https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions');
  });
});

describe('System One 双阈值区间', () => {
  /** 概率数组直接作为算法输入，不替换 SDK 或网络。 */
  function select(probabilities: number[], indices = probabilities.map((_, index) => index)) {
    const answers: Record<string, NoulResponse> = Object.fromEntries(indices.map((index, position) => [
      `caption_${index}`, { type: 'noul', noul: probabilities[position] },
    ]));
    return mergeAdIndices(selectAdIndices(indices, answers));
  }

  it('从核心向两侧扩展，并保留广告内部的低概率字幕', () => {
    expect(select([0.02, 0.2, 0.5, 0.3, 0.25, 0.54, 0.2, 0.04])).toEqual([[1, 6]]);
  });

  it('回放用户提供的 633 条真实 Jev 响应，得到连续的 47–72 区间', () => {
    expect(transcriptProbabilities.probabilities).toHaveLength(633);
    expect(select(transcriptProbabilities.probabilities)).toEqual([[47, 72]]);
  });

  it('没有达到核心阈值的区间不识别为广告', () => {
    expect(select([0.2, 0.49, 0.3, 0.04])).toEqual([]);
  });

  it('低于边界阈值时断开，不连接两段独立广告', () => {
    expect(select([0.5, 0.2, 0.19, 0.3, 0.6])).toEqual([[0, 1], [3, 4]]);
  });

  it('不跨越缺失的字幕索引扩展', () => {
    expect(select([0.5, 0.2, 0.2, 0.3], [2, 3, 7, 8])).toEqual([[2, 3]]);
  });

  it('保留首尾广告以及单条核心字幕', () => {
    expect(select([0.5, 0.02, 0.2, 0.5])).toEqual([[0, 0], [2, 3]]);
    expect(select([])).toEqual([]);
  });
});

describe('System One 服务商', () => {
  it.each(SYSTEM_ONE_PRESETS)('$name 的 SDK 地址与配置端点一致', (preset) => {
    const settings = resolveLLMSettings({ provider: 'system_one', baseUrl: preset.baseUrl, model: preset.defaultModel });
    expect(`${getSystemOneSdkBaseUrl(settings.baseUrl)}/v1/systemone`).toBe(settings.apiUrl);
    expect(findSystemOnePreset(settings.apiUrl)).toBe(preset);
    expect(findSystemOnePreset(`${preset.baseUrl}/`)).toBe(preset);
  });

  it('保留 Vercel 与 OpenCode 的网关路径和各自模型名称', () => {
    expect(findSystemOnePreset('https://ai-gateway.vercel.sh/typesafe')?.defaultModel).toBe('typesafe-ai/jev');
    expect(findSystemOnePreset('https://opencode.ai/inference/systemone/v1')?.defaultModel).toBe('jev-1.13');
    expect(getSystemOneSdkBaseUrl('https://opencode.ai/inference/systemone/v1')).toBe('https://opencode.ai/inference/systemone');
    expect(findSystemOnePreset('https://api.example.com/v1')).toBeUndefined();
  });

  it('仅向火山方舟的 System One 端点添加 beta 请求头', () => {
    expect(findSystemOnePreset('https://ark.cn-beijing.volces.com/api/v1/systemone')?.headers)
      .toEqual({ 'ark-beta-systemone-api': 'true' });
    for (const preset of SYSTEM_ONE_PRESETS.filter((item) => item.name !== '火山方舟')) {
      expect(preset.headers).toBeUndefined();
    }
  });
});
