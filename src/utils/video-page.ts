/** 统一识别插件支持的 B 站视频页面，供设置弹窗和内容脚本使用。 */
export function isBilibiliVideoPage(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.hostname !== 'bilibili.com' && !parsed.hostname.endsWith('.bilibili.com')) return false;

  if (parsed.pathname.startsWith('/video/') || /^\/list\/watchlater(?:\/|$)/.test(parsed.pathname)) {
    return true;
  }
  // 专题首页也使用 festival 路径，只有携带有效 BV 号时才进入视频检测。
  return parsed.pathname.startsWith('/festival/')
    && /^BV[0-9A-Za-z]+$/.test(parsed.searchParams.get('bvid') || '');
}
