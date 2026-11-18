/**
 * 视频卡片场景注册表：不同页面/美化插件下视频列表的 DOM 结构各不相同。
 * 参考自 BilibiliSponsorBlock 的 thumbnail-selectors（每场景独立配置，
 * 含美化插件如 BewlyBewly（Shadow DOM 渲染）与 bilibili-gate 的专门适配）。
 *
 * 标签挂载点用锚点元素而非卡片根：美化插件（如 Bilibili-Evolved）可能隐藏
 * 原封面图，挂在会隐藏的元素内部标签会跟着消失，挂兄弟节点/锚点更稳。
 */

export interface VideoCardScenario {
  /** 场景标识，用于日志与去重 */
  key: string;
  /** 视频列表容器选择器（MutationObserver 的观察点） */
  containerSelector: string;
  /** 单张视频卡片选择器 */
  cardSelector: string;
  /** BV 号所在链接的选择器（默认 a[href]） */
  linkSelector?: string;
  /** BV 号提取的属性名（默认 href，播放列表场景用 data-key） */
  linkAttribute?: string;
  /** 标签挂载锚点（卡片内查询）；缺省挂卡片根 */
  labelAnchorSelector?: string;
  /** Shadow DOM 宿主选择器（美化插件场景）；存在时全部查询在该 shadow root 内进行 */
  shadowHostSelector?: string;
}

export const VIDEO_CARD_SCENARIOS: Record<string, VideoCardScenario> = {
  // B 站官方主页推荐流
  mainPageRecommendation: {
    key: 'mainPageRecommendation',
    containerSelector: '.recommended-container_floor-aside .container',
    cardSelector: '.bili-video-card',
    labelAnchorSelector: '.bili-video-card__image picture',
  },
  // bilibili-gate 脚本重排的主页
  bilibiliGateMainPage: {
    key: 'bilibiliGateMainPage',
    containerSelector: '.bilibili-gate-video-grid',
    cardSelector: '.bili-video-card',
    labelAnchorSelector: '.bili-video-card__cover > img',
  },
  // BewlyBewly / BewlyCat 插件主页（Shadow DOM 渲染）
  bewlybewlyMainPage: {
    key: 'bewlybewlyMainPage',
    containerSelector: '.bewly-scroll-viewport',
    cardSelector: '.video-card',
    labelAnchorSelector: '.vertical-card-cover img',
    shadowHostSelector: '#bewly',
  },
  // 官方搜索页
  search: {
    key: 'search',
    containerSelector: '.search-page-wrapper',
    cardSelector: '.bili-video-card',
  },
  // 热门页（卡片与主页同款，容器不固定，退化为全页扫描）
  popular: {
    key: 'popular',
    containerSelector: 'body',
    cardSelector: '.bili-video-card',
    labelAnchorSelector: '.bili-video-card__image picture',
  },
  // 动态页（关注流，卡片结构与主页不同，链接在卡片内部）
  dynamic: {
    key: 'dynamic',
    containerSelector: '.bili-dyn-list',
    cardSelector: '.bili-dyn-content',
  },
};

/**
 * 解析场景的查询根：普通场景为 document，Shadow DOM 场景为宿主的 shadowRoot。
 * 宿主未渲染（插件未安装/未就绪）时返回 null，场景静默跳过。
 */
export function resolveScenarioRoot(scenario: VideoCardScenario, doc: Document): Document | ShadowRoot | null {
  if (!scenario.shadowHostSelector) return doc;
  const host = doc.querySelector(scenario.shadowHostSelector);
  return host?.shadowRoot ?? null;
}

/**
 * 从链接值解析 BV 号：限定视频路径，避免卡片内其他 BV 引用（简介提及、作者主页等）误提取。
 * 照搬 BilibiliSponsorBlock 的 getBvIDFromURL 语义。
 */
export function bvidFromUrlValue(value: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, location.origin);
    if (!url.pathname.startsWith('/video/')) return null;
    const match = url.pathname.match(/BV[0-9A-Za-z]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

/**
 * 从卡片元素提取 BV 号（照搬 BilibiliSponsorBlock 的多链接判定规则）：
 * 收集卡片内全部链接逐个解析，去重后恰好一个才返回，0 个或多个（歧义）返回 null。
 * @param scenario 场景配置（决定链接选择器与属性）
 * @param card 卡片元素
 */
export function extractBvidFromCard(scenario: VideoCardScenario, card: Element): string | null {
  const linkSelector = scenario.linkSelector ?? 'a[href]';
  const linkAttribute = scenario.linkAttribute ?? 'href';
  const values: Array<string | null> = [];

  // 卡片自身就是链接的情况（如播放列表文字条目）
  if ((card as HTMLElement).matches?.(linkSelector)) {
    values.push(card.getAttribute(linkAttribute));
  }
  card.querySelectorAll(linkSelector).forEach((link) => {
    values.push(link.getAttribute(linkAttribute));
  });

  const bvids = new Set(values.filter((value): value is string => Boolean(value)).map(bvidFromUrlValue).filter(Boolean));
  return bvids.size === 1 ? [...bvids][0] : null;
}
