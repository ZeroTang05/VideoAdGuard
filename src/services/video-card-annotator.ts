/**
 * 在 B 站列表页标注云端已有的广告和 AI 感结果。
 * 卡片选择器及封面定位参考 BilibiliSponsorBlock 的 thumbnail-utils（GPL-2.0）。
 */

import { CloudCacheService, RemoteBatchItem } from './cloud-cache';
import {
  VIDEO_CARD_SCENARIOS,
  VideoCardScenario,
  extractBvidFromCard,
  resolveScenarioRoot,
} from './video-card-scenarios';
import { getVideoCardScenarios } from '../utils/video-page';
import { aiScriptLabelText } from '../utils/script-result';

const BADGE_CONTAINER_CLASS = 'vag-home-badges10032';
const BADGE_SELECTOR = '.' + BADGE_CONTAINER_CLASS;
const LABEL_RENDER_MARGIN = '500px 0px';
// 已加载的首批卡片尽快查；后续新加载的零散卡片等一会儿再合批。
const MIN_BATCH_SIZE = 12;
const MAX_BATCH_SIZE = 30;
const BATCH_GATHER_MS = 250;
const PARTIAL_BATCH_GATHER_MS = 2000;
const MIN_REQUEST_INTERVAL_MS = 1500;
const RETRY_DELAY_MS = 6000;
const MAX_CONSECUTIVE_FAILURES = 2;

interface VideoCard {
  element: HTMLElement;
  scenario: VideoCardScenario;
  nearby: boolean;
  bvid: string | null;
  linkDirty: boolean;
  anchorDirty: boolean;
  badge: { bvid: string; anchor: Element; element: HTMLElement } | null;
}

/** 新增或换了视频的卡片触发查询，接近视口时才需要渲染标签。 */
class VagCardObserver {
  private readonly cards = new Map<Element, VideoCard>();
  private readonly visibilityObserver: IntersectionObserver;
  private readonly mutationObserver: MutationObserver;

  constructor(
    readonly container: Element,
    private readonly scenario: VideoCardScenario,
    private readonly updateCard: (card: VideoCard) => void,
    private readonly releaseCard: (card: VideoCard) => void,
    onContainerRemoved: () => void,
  ) {
    this.visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const card = this.cards.get(entry.target);
        if (!card) continue;
        const nearby = entry.isIntersecting && entry.boundingClientRect.width > 0 && entry.boundingClientRect.height > 0;
        if (nearby === card.nearby) continue;
        card.nearby = nearby;
        if (nearby) this.updateCard(card);
      }
    }, { rootMargin: LABEL_RENDER_MARGIN });

    this.mutationObserver = new MutationObserver((mutations) => {
      if (!container.isConnected) {
        this.disconnect();
        onContainerRemoved();
        return;
      }
      for (const mutation of mutations) this.handleMutation(mutation);
    });
    const linkAttribute = scenario.linkAttribute ?? 'href';
    this.mutationObserver.observe(container, {
      attributes: true,
      attributeFilter: [linkAttribute],
      childList: true,
      subtree: true,
    });
    if (container.parentNode) this.mutationObserver.observe(container.parentNode, { childList: true });

    this.forEachCardElement(container, (element) => this.observeCard(element));
  }

  disconnect(): void {
    this.mutationObserver.disconnect();
    this.visibilityObserver.disconnect();
    for (const card of this.cards.values()) this.release(card);
    this.cards.clear();
  }

  private handleMutation(mutation: MutationRecord): void {
    const target = mutation.target;
    if (!(target instanceof Element) || target.closest(BADGE_SELECTOR) || !this.container.contains(target)) return;

    const cardElement = target.closest(this.scenario.cardSelector);
    const card = cardElement && this.cards.get(cardElement);
    if (mutation.type === 'attributes') {
      if (!card) return;
      card.linkDirty = true;
      this.updateCard(card);
      return;
    }

    const links = this.scenario.linkSelector ?? 'a[href]';
    let hasChangedElement = false;
    let hasChangedLink = false;
    mutation.addedNodes.forEach((node) => {
      if (!(node instanceof Element) || node.matches(BADGE_SELECTOR) || !this.container.contains(node)) return;
      // 卡片内部的变动只需检查链接和封面；列表新增的子树才需要发现新卡片。
      if (!card) this.forEachCardElement(node, (element) => this.observeCard(element));
      hasChangedElement = true;
      if (card && (node.matches(links) || node.querySelector(links))) hasChangedLink = true;
    });
    mutation.removedNodes.forEach((node) => {
      if (!(node instanceof Element) || node.matches(BADGE_SELECTOR)) return;
      if (!card && !this.container.contains(node)) this.forEachCardElement(node, (element) => this.unobserveCard(element));
      hasChangedElement = true;
      if (card && (node.matches(links) || node.querySelector(links))) hasChangedLink = true;
    });
    if (!card || !hasChangedElement) return;
    card.linkDirty ||= hasChangedLink;
    card.anchorDirty = true;
    if (card.nearby || card.linkDirty) this.updateCard(card);
  }

  private forEachCardElement(root: Element, visit: (element: HTMLElement) => void): void {
    const selector = this.scenario.cardSelector;
    if (root instanceof HTMLElement && root.matches(selector)) visit(root);
    root.querySelectorAll<HTMLElement>(selector).forEach(visit);
  }

  private observeCard(element: HTMLElement): void {
    if (this.cards.has(element)) return;
    const card: VideoCard = {
      element,
      scenario: this.scenario,
      nearby: false,
      bvid: null,
      linkDirty: true,
      anchorDirty: true,
      badge: null,
    };
    this.cards.set(element, card);
    this.visibilityObserver.observe(element);
    this.updateCard(card);
  }

  private unobserveCard(element: HTMLElement): void {
    const card = this.cards.get(element);
    if (!card || this.container.contains(element)) return;
    this.visibilityObserver.unobserve(element);
    this.cards.delete(element);
    this.release(card);
  }

  private release(card: VideoCard): void {
    card.nearby = false;
    this.releaseCard(card);
    card.badge?.element.remove();
  }
}

export class VideoCardAnnotator {
  // 缓存成功查询的所有结果，包括无标签的视频；重复出现时直接使用页面内缓存。
  private static readonly results = new Map<string, RemoteBatchItem | null>();
  private static readonly waiting = new Map<string, Set<VideoCard>>();
  private static readonly dirtyCards = new Set<VideoCard>();
  private static readonly observedContainers = new Map<string, VagCardObserver>();

  private static started = false;
  private static renderFrame: number | null = null;
  private static rescanTimer: number | null = null;
  private static flushTimer: number | null = null;
  private static requesting = false;
  private static lastQueuedAt = -Infinity;
  private static lastRequestAt = -Infinity;
  private static retryAt = -Infinity;
  private static failures = 0;

  public static async start(): Promise<void> {
    if (this.started) return;
    const settings = await chrome.storage.local.get(['enableExtension']);
    if (settings.enableExtension === false || this.started) return;

    this.started = true;
    this.refreshContainers();
    // 只检查场景和容器是否换了；沿用现有容器时不会重新遍历卡片。
    window.setInterval(() => this.refreshContainers(), 3000);
  }

  /** SPA 换页或容器加载较晚时发现新容器，已有容器继续增量观察。 */
  private static refreshContainers(): void {
    const activeKeys = new Set(getVideoCardScenarios(location.href));
    for (const [key, observer] of this.observedContainers) {
      if (activeKeys.has(key) && observer.container.isConnected) continue;
      observer.disconnect();
      this.observedContainers.delete(key);
    }

    for (const key of activeKeys) {
      if (this.observedContainers.has(key)) continue;
      const scenario = VIDEO_CARD_SCENARIOS[key];
      if (!scenario) continue;
      const container = resolveScenarioRoot(scenario, document)?.querySelector(scenario.containerSelector);
      if (!container) continue;

      this.observedContainers.set(key, new VagCardObserver(
        container, scenario,
        (card) => this.scheduleRender(card),
        (card) => {
          this.dirtyCards.delete(card);
          this.removeFromQueue(card);
        },
        () => this.rescanSoon(),
      ));
    }
  }

  private static rescanSoon(): void {
    if (this.rescanTimer !== null) return;
    this.rescanTimer = window.setTimeout(() => {
      this.rescanTimer = null;
      this.refreshContainers();
    }, 100);
  }

  /** 将同一帧的卡片更新合并，先读封面位置，再统一改标签，避免反复触发布局。 */
  private static scheduleRender(card: VideoCard): void {
    this.dirtyCards.add(card);
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      const changes: Array<() => void> = [];
      for (const candidate of this.dirtyCards) {
        if (!candidate.element.isConnected) continue;
        const change = this.prepareCard(candidate);
        if (change) changes.push(change);
      }
      this.dirtyCards.clear();
      for (const change of changes) change();
    });
  }

  private static prepareCard(card: VideoCard): (() => void) | undefined {
    if (card.linkDirty) {
      card.linkDirty = false;
      const bvid = extractBvidFromCard(card.scenario, card.element);
      if (bvid !== card.bvid) {
        this.removeFromQueue(card);
        card.bvid = bvid;
        if (bvid && !this.results.has(bvid)) this.queueCard(bvid, card);
      }
    }

    if (!card.nearby) return;
    const item = card.bvid ? this.results.get(card.bvid) : null;
    if (!card.bvid || !item) {
      if (!card.badge) return;
      return () => {
        card.badge?.element.remove();
        card.badge = null;
      };
    }

    const bvid = card.bvid;
    const previousBadge = card.badge?.bvid === bvid ? card.badge : null;
    if (previousBadge?.element.isConnected && !card.anchorDirty) return;
    card.anchorDirty = false;

    const anchorSelector = card.scenario.labelAnchorSelector;
    // 封面还未渲染时先挂在卡片根；封面出现后由 DOM 观察器移动同一个标签。
    const anchor = (anchorSelector && card.element.querySelector(anchorSelector)) || card.element;
    const host = anchor === card.element ? card.element : anchor.parentElement;
    if (!host) return;
    if (previousBadge?.anchor === anchor && previousBadge.element.parentElement === host) return;

    const badge = previousBadge?.element ?? this.buildBadgeContainer(item);
    if (!badge) return;
    const needsPosition = window.getComputedStyle(host).position === 'static';
    return () => {
      if (card.badge?.element !== badge) card.badge?.element.remove();
      if (needsPosition) host.style.position = 'relative';
      if (anchor === card.element) host.appendChild(badge);
      else anchor.after(badge);
      card.badge = { bvid, anchor, element: badge };
    };
  }

  private static queueCard(bvid: string, card: VideoCard): void {
    const cards = this.waiting.get(bvid);
    if (cards) {
      cards.add(card);
      return;
    }

    this.waiting.set(bvid, new Set([card]));
    this.lastQueuedAt = performance.now();
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) this.failures = 0;
    // 队列攒够时，提前原本为小批量安排的计时器。
    if (this.waiting.size === MIN_BATCH_SIZE) this.clearFlushTimer();
    this.scheduleFlush();
  }

  private static removeFromQueue(card: VideoCard): void {
    if (!card.bvid) return;
    const cards = this.waiting.get(card.bvid);
    if (!cards?.delete(card) || cards.size > 0) return;
    this.waiting.delete(card.bvid);
    if (!this.waiting.size) this.clearFlushTimer();
  }

  private static clearFlushTimer(): void {
    if (this.flushTimer === null) return;
    window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private static nextRequestAt(): number {
    const largeBatch = this.lastRequestAt === -Infinity || this.waiting.size >= MIN_BATCH_SIZE;
    const gatherUntil = this.lastQueuedAt + (largeBatch ? BATCH_GATHER_MS : PARTIAL_BATCH_GATHER_MS);
    return Math.max(gatherUntil, this.lastRequestAt + MIN_REQUEST_INTERVAL_MS, this.retryAt);
  }

  /** 仅按新加载的视频攒批；零散视频稍后补查，失败最多自动重试一次。 */
  private static scheduleFlush(): void {
    if (this.flushTimer !== null || this.requesting || !this.waiting.size || this.failures >= MAX_CONSECUTIVE_FAILURES) return;
    const delay = Math.max(0, this.nextRequestAt() - performance.now());
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      if (!this.waiting.size) return;
      if (performance.now() < this.nextRequestAt()) {
        this.scheduleFlush();
        return;
      }
      void this.flush();
    }, delay);
  }

  private static async flush(): Promise<void> {
    const bvids = [];
    for (const bvid of this.waiting.keys()) {
      bvids.push(bvid);
      if (bvids.length === MAX_BATCH_SIZE) break;
    }
    this.requesting = true;
    this.lastRequestAt = performance.now();
    try {
      const data = await CloudCacheService.fetchRemoteBatch(bvids);
      if (!data) {
        this.failures += 1;
        this.retryAt = performance.now() + RETRY_DELAY_MS;
        return;
      }

      this.failures = 0;
      this.retryAt = -Infinity;
      for (const bvid of bvids) {
        const item = data[bvid];
        const hasBadge = item?.ad?.exist || item?.aiScript || typeof item?.aiScriptLabel === 'boolean';
        this.results.set(bvid, hasBadge ? item : null);
        const cards = this.waiting.get(bvid);
        this.waiting.delete(bvid);
        if (hasBadge && cards) {
          for (const card of cards) {
            if (card.nearby) this.scheduleRender(card);
          }
        }
      }
    } finally {
      this.requesting = false;
      this.scheduleFlush();
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
    if (typeof item.aiScriptLabel === 'boolean') {
      labels.push({
        text: aiScriptLabelText(item.aiScriptLabel),
        color: item.aiScriptLabel ? '#f25d8e' : '#9499a0',
        title: '人工标注',
      });
    } else if (ai) {
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
}
