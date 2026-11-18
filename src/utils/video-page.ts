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

/** 识别 B 站首页（推荐流），供首页卡片标注使用。 */
export function isBilibiliHomepage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.bilibili.com' && parsed.pathname === '/';
  } catch {
    return false;
  }
}

/**
 * 按 URL 判定当前页面适用的视频卡片标注场景（video-card-scenarios 的 key）。
 * 同一页面可命中多个场景：装了美化插件时官方容器与插件容器共存，
 * 各场景查不到自己的容器就静默跳过。
 */
export function getVideoCardScenarios(url: string | undefined): string[] {
  if (!url) return [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  if (parsed.hostname === 'www.bilibili.com') {
    if (parsed.pathname === '/') {
      // BewlyBewly 把搜索/历史塞进 ?page=xxx；无 page 时是主页（官方+插件场景共存）
      return parsed.searchParams.get('page')
        ? ['bewlybewlyMainPage']
        : ['mainPageRecommendation', 'bilibiliGateMainPage', 'bewlybewlyMainPage'];
    }
    if (parsed.pathname.startsWith('/v/popular')) return ['popular'];
    return [];
  }
  if (parsed.hostname === 'search.bilibili.com') return ['search'];
  if (parsed.hostname === 't.bilibili.com') return ['dynamic'];
  return [];
}
