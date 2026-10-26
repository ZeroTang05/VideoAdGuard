/** 覆盖普通页、活动视频页和插件脚本加载范围，验证页面入口保持一致。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isBilibiliVideoPage } from './video-page';

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
