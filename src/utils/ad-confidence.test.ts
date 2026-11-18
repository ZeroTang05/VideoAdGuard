/** 覆盖自动跳过置信度判定的段数上限、占比上限和无效视频时长边界。 */
import { describe, expect, it } from 'vitest';
import { isAutoSkipConfident, MAX_CONFIDENT_AD_SEGMENTS, MAX_CONFIDENT_AD_RATIO } from './ad-confidence';

describe('自动跳过置信度判定', () => {
  it.each([
    [[], 100],
    [[[0, 10]], NaN],
    [[[0, 10]], 0],
    [[[0, 10]], -5],
  ] as [number[][], number][])('判定为不可信：无广告段或视频时长无效（区间=%j, 时长=%j）', (ranges, duration) => {
    expect(isAutoSkipConfident(ranges, duration)).toBe(false);
  });

  it('广告段数达到上限内且占比低于上限时判定可信', () => {
    // 3 段、共 45 秒，视频 100 秒 → 占比 45%
    const ranges = [[0, 15], [20, 35], [60, 75]];
    expect(isAutoSkipConfident(ranges, 100)).toBe(true);
  });

  it('广告段数超过上限时判定不可信（即使占比不高）', () => {
    expect(MAX_CONFIDENT_AD_SEGMENTS).toBe(3);
    // 4 段、共 40 秒，占比 40%，但段数超限
    const ranges = [[0, 10], [20, 30], [40, 50], [60, 70]];
    expect(isAutoSkipConfident(ranges, 100)).toBe(false);
  });

  it.each([
    [[[0, 50]], false], // 占比恰好 50%，条件为严格小于
    [[[0, 49.9]], true],
  ] as [number[][], boolean][])('广告总时长占比边界（视频 100 秒）：区间=%j → %j', (ranges, expected) => {
    expect(MAX_CONFIDENT_AD_RATIO).toBe(0.5);
    expect(isAutoSkipConfident(ranges, 100)).toBe(expected);
  });
});
