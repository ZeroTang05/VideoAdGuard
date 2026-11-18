/**
 * 视频卡片标注器：
 * 在视频入口页面（首页推荐/热门/搜索/动态，及 BewlyBewly、bilibili-gate 等美化插件）
 * 的视频卡片封面上叠加云端已有的广告与 AI 感评分小标签。
 * 首页只读云端共享数据、不做新检测；点进视频页才检测并回填云端。
 *
 * DOM 适配层整体照搬自 BilibiliSponsorBlock（src/thumbnail-utils/，GPL-2.0，与本插件许可证一致）：
 * - 场景注册表（thumbnail-selectors.ts）→ video-card-scenarios.ts
 * - 容器观察与可见性过滤（thumbnailObserver.ts）→ VagCardObserver
 * - 标签插入流程（thumbnails.ts / thumbnailManagement.ts）→ labelCard 及场景管理
 * 业务层（批查询缓存）为本项目实现。与 BSB 的偏离点均有注释说明。
 * 标签全部使用 inline style，Shadow DOM 内可直接生效，无需注入样式表。
 */

import { CloudCacheService, RemoteBatchItem } from './cloud-cache';
import {
  VIDEO_CARD_SCENARIOS,
  VideoCardScenario,
  extractBvidFromCard,
  resolveScenarioRoot,
} from './video-card-scenarios';
import { getVideoCardScenarios } from '../utils/video-page';

// 卡片根上记录已标注 bvid 的 data 属性（照搬 BSB 的 data-bsb-bvid；Vue 复用卡片时据此识别 bvid 变化）
const DATA_BVID_ATTR = 'data-vag-bvid';
// 标签容器类名（observer 据此过滤自身引发的 mutation）
const BADGE_CONTAINER_CLASS = 'vag-home-badges10032';
// 已查询但云端无数据的占位
const NO_RESULT = null;

/** BSB 的 waitFor：轮询等待条件成立（用于锚点延迟渲染），超时抛错 */
function waitFor(conditionsFunction: () => unknown, timeoutMs = 5000, intervalMs = 25): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      const result = conditionsFunction();
      if (result) return resolve(result);
      if (Date.now() - startTime >= timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

interface ResolvedScenario {
  scenario: VideoCardScenario;
  root: Document | ShadowRoot;
}

/**
 * 卡片观察器（照搬 BilibiliSponsorBlock 的 ThumbnailObserver）：
 * - IntersectionObserver 只标注视口内的卡片（首页上百张卡片的性能关键）
 * - MutationObserver 监听容器子树，过滤自身标签引发的变更防止自触发循环
 * - 容器被替换（isConnected=false）时自动断连并通知上层重建
 */
class VagCardObserver {
  private readonly cards = new Set<HTMLElement>();
  private readonly visibleCards = new Set<HTMLElement>();
  private readonly dirtyCards = new Set<HTMLElement>();
  private readonly visibilityObserver: IntersectionObserver;
  private readonly mutationObserver: MutationObserver;
  private readonly selector: string;

  constructor(
    readonly container: Element,
    private readonly scenario: VideoCardScenario,
    private readonly labelCard: (card: HTMLElement, scenario: VideoCardScenario) => void,
    onContainerRemoved: () => void
  ) {
    this.selector = scenario.cardSelector;
    this.visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const card = entry.target as HTMLElement;
        if (!this.cards.has(card)) continue;
        if (entry.isIntersecting && entry.boundingClientRect.width > 0 && entry.boundingClientRect.height > 0) {
          this.visibleCards.add(card);
          this.labelVisibleCard(card);
        } else {
          this.visibleCards.delete(card);
        }
      }
    });

    this.mutationObserver = new MutationObserver((mutations) => {
      // 容器被 SPA 整体替换：断连并通知上层重建
      if (!container.isConnected) {
        this.disconnect();
        onContainerRemoved();
        return;
      }

      const changedCards = new Set<HTMLElement>();
      let nodesRemoved = false;
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        // 自身标签的插入/更新不得触发新一轮标注（防自触发循环）
        if (target?.closest(`.${BADGE_CONTAINER_CLASS}`)) continue;
        if (mutation.type === 'childList') {
          nodesRemoved ||= mutation.removedNodes.length > 0;
          if (!mutation.removedNodes.length && Array.from(mutation.addedNodes).every(
            (node) => node instanceof Element && node.matches(`.${BADGE_CONTAINER_CLASS}`)
          )) continue;

          Array.from(mutation.addedNodes).forEach((node) => {
            if (node instanceof HTMLElement) this.observeCards(node);
          });
        }

        const card = target?.closest<HTMLElement>(this.selector);
        if (card && this.cards.has(card)) changedCards.add(card);
      }

      if (nodesRemoved) this.removeDetachedCards();
      for (const card of changedCards) {
        this.dirtyCards.add(card);
        this.labelVisibleCard(card);
      }
    });
    this.mutationObserver.observe(container, {
      attributes: true,
      attributeFilter: [scenario.linkAttribute ?? 'href'],
      childList: true,
      subtree: true,
    });
    if (container.parentNode) this.mutationObserver.observe(container.parentNode, { childList: true });
    this.observeCards(container);
  }

  /** 容器仍在时全量刷新：重收卡片、重标可见卡片（数据到达后由上层触发 invalidate） */
  refresh(invalidateLabels = false): void {
    this.removeDetachedCards();
    this.observeCards(this.container);
    if (invalidateLabels) {
      for (const card of this.cards) this.dirtyCards.add(card);
    }
    for (const card of this.visibleCards) this.labelVisibleCard(card);
  }

  disconnect(): void {
    this.mutationObserver.disconnect();
    this.visibilityObserver.disconnect();
    this.cards.clear();
    this.visibleCards.clear();
    this.dirtyCards.clear();
  }

  private observeCards(root: Element): void {
    if (!this.container.contains(root)) return;
    if (root.matches(this.selector)) this.observeCard(root as HTMLElement);
    root.querySelectorAll<HTMLElement>(this.selector).forEach((card) => this.observeCard(card));
  }

  private observeCard(card: HTMLElement): void {
    if (this.cards.has(card)) return;
    this.cards.add(card);
    this.dirtyCards.add(card);
    this.visibilityObserver.observe(card);
  }

  private removeDetachedCards(): void {
    for (const card of this.cards) {
      if (!this.container.contains(card)) {
        this.visibilityObserver.unobserve(card);
        this.cards.delete(card);
        this.visibleCards.delete(card);
        this.dirtyCards.delete(card);
      }
    }
  }

  /** 只标注脏且可见的卡片；离开视口保留已有标签（照搬 BSB 缓存语义） */
  private labelVisibleCard(card: HTMLElement): void {
    if (this.dirtyCards.has(card) && this.visibleCards.has(card) && card.isConnected && this.container.contains(card)) {
      this.dirtyCards.delete(card);
      this.labelCard(card, this.scenario);
    }
  }
}

export class VideoCardAnnotator {
  /** bvid -> 云端结果；null 表示已查询但云端无数据 */
  private static results = new Map<string, RemoteBatchItem | typeof NO_RESULT>();
  /** 待查询的 bvid 队列（合批用） */
  private static pending = new Set<string>();
  private static flushTimer: number | null = null;
  private static rescanTimer: number | null = null;
  /** 场景 key -> 观察器（照搬 BSB 的 observedContainers） */
  private static observedContainers = new Map<string, VagCardObserver>();
  private static rescanInterval: number | null = null;
  /** 正在标注的卡片（照搬 BSB 的并发去重，防止对同一卡片并发插入标签） */
  private static labeling = new Set<HTMLElement>();
  /** 并发去重期间的待重跑场景 */
  private static rerunScenarios = new WeakMap<HTMLElement, VideoCardScenario>();

  public static async start(): Promise<void> {
    const settings = await chrome.storage.local.get(['enableExtension']);
    if (settings.enableExtension === false) return;

    this.refreshContainers();
    if (!this.observedContainers.size) {
      console.log('【VideoAdGuard】当前页面无匹配的视频卡片场景，标注器未启动');
      return;
    }

    // 兜底轮询：SPA 站内跳转 / 容器整体替换时刷新场景集（BSB 靠 URL watcher，此处用等价的低频轮询）
    this.rescanInterval = window.setInterval(() => this.refreshContainers(), 3000);
    console.log('【VideoAdGuard】视频卡片标注已启动，场景:', [...this.observedContainers.keys()].join(', '));
  }

  /** 刷新场景容器集：按当前 URL 的场景列表增删观察器（照搬 BSB 的 refreshThumbnailContainers） */
  private static refreshContainers(): void {
    const activeKeys = new Set<string>();

    for (const key of getVideoCardScenarios(location.href)) {
      const scenario = VIDEO_CARD_SCENARIOS[key];
      if (!scenario) continue;
      activeKeys.add(key);

      const observed = this.observedContainers.get(key);
      // 容器仍在：沿用现有观察器
      if (observed && observed.container.isConnected) continue;
      // 容器被替换：重建（observer 的 disconnect 已由其自身触发）
      if (observed) this.observedContainers.delete(key);

      const root = resolveScenarioRoot(scenario, document);
      if (!root) continue; // 美化插件未安装/未就绪，静默跳过
      const container = root.querySelector(scenario.containerSelector);
      if (!container) continue;

      this.observedContainers.set(key, new VagCardObserver(
        container, scenario,
        (card, scenarioForCard) => void this.labelCard(card, scenarioForCard),
        () => this.rescanSoon(),
      ));
    }

    // 移除不再活跃的场景
    for (const key of [...this.observedContainers.keys()]) {
      if (!activeKeys.has(key)) {
        this.observedContainers.get(key)?.disconnect();
        this.observedContainers.delete(key);
      }
    }
  }

  /** 防抖重扫（照搬 BSB 的 checkPageForNewThumbnails 100ms 防抖） */
  private static rescanSoon(): void {
    if (this.rescanTimer) return;
    this.rescanTimer = window.setTimeout(() => {
      this.rescanTimer = null;
      this.refreshContainers();
    }, 100);
  }

  /**
   * 标注单张卡片（照搬 BSB 的 labelThumbnail 并发去重结构）。
   * 数据未查询时仅入队；flush 返回后会 refresh 观察器重标可见卡片。
   */
  private static async labelCard(card: HTMLElement, scenario: VideoCardScenario): Promise<void> {
    if (this.labeling.has(card)) {
      this.rerunScenarios.set(card, scenario);
      return;
    }
    this.labeling.add(card);

    try {
      await this.labelCardProcess(card, scenario);
    } finally {
      this.labeling.delete(card);
      const rerun = this.rerunScenarios.get(card);
      this.rerunScenarios.delete(card);
      if (rerun && card.isConnected) void this.labelCard(card, rerun);
    }
  }

  private static async labelCardProcess(card: HTMLElement, scenario: VideoCardScenario): Promise<void> {
    // 卡片复用检测：标记挂卡片根（照搬 BSB 的 data-bsb-bvid 挂 thumbnail 根）
    let bvid = card.getAttribute(DATA_BVID_ATTR);
    const extracted = extractBvidFromCard(scenario, card);
    if (extracted !== bvid) {
      // bvid 变化或首次处理：清旧标签
      this.hideLabel(card);
      bvid = extracted;
      if (!bvid) return;
      card.setAttribute(DATA_BVID_ATTR, bvid);
      this.pending.add(bvid);
      this.scheduleFlush();
      return;
    }
    if (!bvid) return;

    // 查询结果未到达：等待下一次 refresh
    if (!this.results.has(bvid)) return;

    const item = this.results.get(bvid);
    if (!item) {
      // 已查询且云端无数据：无标签
      this.hideLabel(card);
      return;
    }

    const container = this.buildBadgeContainer(item);
    if (!container) {
      this.hideLabel(card);
      return;
    }

    // 等锚点渲染完成再插入（照搬 BSB：锚点可能晚于卡片出现，立即查会插错位置）
    const labelAnchor = await waitFor(
      () => (scenario.labelAnchorSelector ? card.querySelector(scenario.labelAnchorSelector) : card),
      10000, 100
    ).catch(() => null) as HTMLElement | null
      // 锚点缺失时兜底到最后一个子元素，保证标签仍落在卡片内部（照搬 BSB 的 lastElementChild 兜底）
      ?? card.lastElementChild as HTMLElement | null;
    if (!labelAnchor?.parentNode || !card.isConnected) return;
    this.hideLabel(card);

    if (labelAnchor !== card && labelAnchor.parentElement) {
      // 标签插为锚点的兄弟节点（照搬 BSB 的 labelAnchor.after）：锚点可能是
      // <picture>/<img> 这类无法承载子元素定位的元素，塞内部会不可见。
      // 定位上下文补在锚点父元素（封面容器，有实际尺寸）上。
      const host = labelAnchor.parentElement as HTMLElement;
      if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative';
      labelAnchor.after(container);
    } else {
      if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(container);
    }
  }

  /** 组装标签容器：按云端结果渲染广告/AI 感标签，无数据返回 null */
  private static buildBadgeContainer(item: RemoteBatchItem): HTMLElement | null {
    const labels: Array<{ text: string; color: string; title: string }> = [];

    if (item.ad?.exist) {
      const goods = (item.ad.goodName || []).filter(Boolean);
      const title = goods.length ? `检测到广告：${goods.join('、')}` : '检测到植入广告';
      labels.push({
        text: goods.length ? `广告·${goods[0].slice(0, 8)}` : '含广告',
        color: '#fb7299',
        title,
      });
    }

    const ai = item.aiScript;
    if (ai) {
      labels.push({
        text: `AI 感 ${ai.aiScore}`,
        color: ai.aiScore >= 70 ? '#f25d8e' : ai.aiScore >= 40 ? '#ff7f24' : '#9499a0',
        title: `AI 风格评分 ${ai.aiScore}/100`,
      });
    }

    if (!labels.length) return null;

    // 定位对齐 BSB 的 .sponsorThumbnailLabel：top/left 0 + margin 提供缩进
    const container = document.createElement('div');
    container.className = BADGE_CONTAINER_CLASS;
    container.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      margin: 6px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      z-index: 5;
      pointer-events: none;
    `;
    for (const label of labels) {
      const el = document.createElement('span');
      el.className = 'vag-home-badge10032';
      el.textContent = label.text;
      el.title = label.title;
      el.style.cssText = `
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 11px;
        line-height: 16px;
        font-weight: 600;
        color: #fff;
        background: ${label.color}ee;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      `;
      container.appendChild(el);
    }
    return container;
  }

  /** 清除卡片子树内的全部标签 */
  private static hideLabel(card: Element): void {
    card.querySelectorAll(`.${BADGE_CONTAINER_CLASS}`).forEach((el) => el.remove());
  }

  /** 合批：新 bvid 收集 500ms 后一次查询，减少请求数 */
  private static scheduleFlush(): void {
    if (this.flushTimer || !this.pending.size) return;
    this.flushTimer = window.setTimeout(() => { void this.flush(); }, 500);
  }

  private static async flush(): Promise<void> {
    this.flushTimer = null;
    // 服务端单次上限 30 个，超出部分留在队列下一轮
    const bvids = [...this.pending].slice(0, 30);
    for (const bvid of bvids) this.pending.delete(bvid);
    if (!bvids.length) return;

    const data = await CloudCacheService.fetchRemoteBatch(bvids);
    if (data) {
      // 查询成功：无数据的视频记为 NO_RESULT（明确无标签），有数据的记入缓存
      for (const bvid of bvids) {
        this.results.set(bvid, data?.[bvid] ?? NO_RESULT);
      }
    } else {
      // 查询失败：保持待查询状态，重新入队等下一轮重试（失败≠云端无数据）
      for (const bvid of bvids) this.pending.add(bvid);
    }
    for (const observer of this.observedContainers.values()) {
      observer.refresh(true);
    }
    if (this.pending.size) this.scheduleFlush();
  }
}
