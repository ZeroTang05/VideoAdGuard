/**
 * 自动跳过置信度判定
 *
 * 自动跳过只对"可信"的检测结果生效：广告段数少、总时长占比低。
 * AI 现场检测与云端缓存加载共用本函数，保证不同来源的行为一致。
 */

/** 允许自动跳过的最大广告段数（合并相邻/重叠区间后的实际广告块数量） */
export const MAX_CONFIDENT_AD_SEGMENTS = 3;

/** 允许自动跳过的广告总时长占视频总时长的最大比例 */
export const MAX_CONFIDENT_AD_RATIO = 0.5;

/**
 * 判断一次检测结果是否满足自动跳过条件
 * @param adTimeRanges 广告时间段列表（秒），需为已合并的区间
 * @param videoDuration 视频总时长（秒）；无效（NaN 或 ≤ 0）时无法计算占比，判为不可信
 */
export function isAutoSkipConfident(adTimeRanges: number[][], videoDuration: number): boolean {
  if (adTimeRanges.length === 0 || adTimeRanges.length > MAX_CONFIDENT_AD_SEGMENTS) {
    return false;
  }
  if (isNaN(videoDuration) || videoDuration <= 0) {
    return false;
  }
  const totalAdDuration = adTimeRanges.reduce((sum, [start, end]) => sum + (end - start), 0);
  return totalAdDuration < videoDuration * MAX_CONFIDENT_AD_RATIO;
}
