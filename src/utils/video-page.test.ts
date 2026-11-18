/** 覆盖普通页、活动视频页和插件脚本加载范围，验证页面入口保持一致。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getVideoCardScenarios, isBilibiliVideoPage } from './video-page';
import { VIDEO_CARD_SCENARIOS } from '../services/video-card-scenarios';

describe('B 站视频页面识别', () => {
  it.each([
    'https://www.bilibili.com/festival/S16?bvid=BV1dHHP6FEiL',
    'https://www.bilibili.com/festival/S16?foo=bar&bvid=BV1dHHP6FEiL&spm_id_from=333',
    'https://www.bilibili.com/festival/S16?bvid=BV1ZgH36DEb7',
    'https://www.bilibili.com/video/BV1dHHP6FEiL/',
    'https://www.bilibili.com/video/av170001/',
    'https://www.bilibili.com/list/watchlater?bvid=BV1dHHP6FEiL',
    'https://www.bilibili.com/list/watchlater',
  ])('识别支持的视频页面：%s', (url) => {
    expect(isBilibiliVideoPage(url)).toBe(true);
  });

  it.each([
    undefined,
    '无效网址',
    'https://www.bilibili.com/',
    'https://www.bilibili.com/festival/S16',
    'https://www.bilibili.com/festival/S16?bvid=',
    'https://www.bilibili.com/festival/S16?bvid=invalid',
    'https://www.bilibili.com/list/watchlater-other',
    'https://www.bilibili.com.example.com/festival/S16?bvid=BV1dHHP6FEiL',
    'https://example.com/?next=https://www.bilibili.com/video/BV1dHHP6FEiL',
  ])('跳过没有视频的专题及非视频页面：%s', (url) => {
    expect(isBilibiliVideoPage(url)).toBe(false);
  });

  it.each(['chrome', 'firefox'])('%s 扩展在活动页加载检测脚本', (browser) => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'manifests', `manifest-${browser}.json`), 'utf8'));
    const script = manifest.content_scripts.find((entry: { js: string[] }) => entry.js.includes('content.js'));
    expect(script.matches).toContain('*://*.bilibili.com/festival/*');
    expect(script.matches).toContain('*://*.bilibili.com/video/*');
    expect(script.matches).toContain('*://*.bilibili.com/list/watchlater*');
  });
});

describe('视频卡片标注场景判定', () => {
  it.each([
    ['https://www.bilibili.com/', ['mainPageRecommendation', 'bilibiliGateMainPage', 'bewlybewlyMainPage']],
    // BewlyBewly 把搜索/历史塞进主页路径的 query
    ['https://www.bilibili.com/?page=SearchResults', ['bewlybewlyMainPage']],
    ['https://www.bilibili.com/?page=History', ['bewlybewlyMainPage']],
    ['https://www.bilibili.com/v/popular/all', ['popular']],
    ['https://search.bilibili.com/all?keyword=test', ['search']],
    ['https://t.bilibili.com/', ['dynamic']],
  ])('识别标注场景：%s', (url, expected: string[]) => {
    expect(getVideoCardScenarios(url as string)).toEqual(expected);
  });

  it.each([
    undefined,
    '无效网址',
    'https://www.bilibili.com/video/BV1dHHP6FEiL/',
    'https://account.bilibili.com/history',
    'https://live.bilibili.com/',
  ])('非视频入口页面不标注：%s', (url) => {
    expect(getVideoCardScenarios(url as string)).toEqual([]);
  });

  it('场景注册表每个条目字段完整且 key 一致', () => {
    for (const [key, scenario] of Object.entries(VIDEO_CARD_SCENARIOS)) {
      expect(scenario.key).toBe(key);
      expect(scenario.containerSelector).toBeTruthy();
      expect(scenario.cardSelector).toBeTruthy();
    }
  });

  it('BewlyBewly 场景声明了 Shadow DOM 宿主', () => {
    expect(VIDEO_CARD_SCENARIOS.bewlybewlyMainPage.shadowHostSelector).toBe('#bewly');
  });
});
