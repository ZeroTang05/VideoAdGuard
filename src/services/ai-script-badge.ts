/** 视频信息行的 AI 感角标与两项人工标注。 */
import { CloudCacheService } from './cloud-cache';
import type { VideoPart } from './bilibili';
import { aiScriptLabelText } from '../utils/script-result';

const PANEL_WIDTH = 136;
const PANEL_GAP = 4;
const VIEWPORT_GUTTER = 8;

export class AiScriptBadge {
  private readonly container = document.createElement('div');
  private readonly badge = document.createElement('span');
  private readonly trigger = document.createElement('button');
  private readonly panel = document.createElement('div');
  private readonly status = document.createElement('span');
  private mountTimer: number | undefined;
  private panelListeners: AbortController | undefined;
  private saving = false;
  private manualLabel: boolean | null = null;

  constructor(private readonly part: VideoPart) {
    this.container.className = 'ai-script-controls10032';
    this.container.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:12px;';

    this.badge.className = 'ai-script-badge10032';
    this.badge.style.cssText = 'display:none;padding:2px 8px;border:1px solid;border-radius:6px;font-size:12px;font-weight:600;white-space:nowrap;';

    this.trigger.type = 'button';
    this.trigger.textContent = '标注';
    this.trigger.title = '标注文案';
    this.trigger.style.cssText = 'border:0;background:none;color:var(--text2,#61666d);padding:2px 4px;font-size:12px;cursor:pointer;white-space:nowrap;';
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.addEventListener('click', () => {
      if (this.panel.isConnected) this.closePanel();
      else this.openPanel();
    });

    this.panel.setAttribute('role', 'group');
    this.panel.setAttribute('aria-label', '文案标注');
    this.panel.style.cssText = `position:fixed;z-index:10000;box-sizing:border-box;width:${PANEL_WIDTH}px;padding:4px;background:var(--bg1,#fff);border:1px solid var(--line_regular,#e3e5e7);border-radius:8px;box-shadow:0 3px 12px #0002;white-space:nowrap;`;

    for (const isAiScript of [true, false]) {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = aiScriptLabelText(isAiScript);
      option.style.cssText = 'display:block;width:100%;border:0;border-radius:4px;background:transparent;padding:5px 10px;text-align:left;color:var(--text1,#18191c);font-size:12px;cursor:pointer;';
      option.addEventListener('click', () => void this.submit(isAiScript));
      this.panel.appendChild(option);
    }
    this.status.setAttribute('role', 'status');
    this.status.style.cssText = 'display:block;color:#c22e4c;font-size:12px;';
    this.panel.appendChild(this.status);

    this.container.append(this.badge, this.trigger);
  }

  get hasManualLabel(): boolean {
    return this.manualLabel !== null;
  }

  /** 信息行可能晚于内容脚本出现，换视频时会取消尚未执行的重试。 */
  private mount(retryCount = 0): void {
    const detailList = document.querySelector('.video-info-detail-list.video-info-detail-content');
    if (detailList) {
      detailList.appendChild(this.container);
    } else if (retryCount < 5) {
      this.mountTimer = window.setTimeout(() => this.mount(retryCount + 1), 1000);
    }
  }

  remove(): void {
    window.clearTimeout(this.mountTimer);
    this.closePanel();
    this.container.remove();
  }

  showScore(score: number, provider: string, model: string, source: 'local' | 'remote' | 'ai'): void {
    if (this.hasManualLabel) return;
    const color = score >= 70 ? '#f25d8e' : score >= 40 ? '#ff7f24' : '#9499a0';
    const sourceName = source === 'local' ? '本地缓存' : source === 'remote' ? '云端共享' : 'AI 检测';
    this.showBadge(
      `AI 感 ${score}/100`,
      `AI 风格评分 ${score}/100（模式化、冗余、抽象化等特征强度）\n来源: ${provider} / ${model}（${sourceName}）`,
      color,
    );
  }

  showLabel(isAiScript: boolean): void {
    this.manualLabel = isAiScript;
    this.trigger.textContent = '修改';
    this.trigger.title = '修改文案标注';
    this.showBadge(aiScriptLabelText(isAiScript), '人工标注', isAiScript ? '#f25d8e' : '#9499a0');
  }

  private showBadge(text: string, title: string, color: string): void {
    const firstResult = !this.badge.textContent;
    this.badge.textContent = text;
    this.badge.title = title;
    this.badge.style.display = 'inline-flex';
    this.badge.style.color = color;
    this.badge.style.backgroundColor = color + '1a';
    this.badge.style.borderColor = color + '55';
    // 有了评分或人工结果才挂载整组，避免单独出现标注按钮。
    if (firstResult) this.mount();
  }

  /** 信息行只挂角标和按钮，菜单定位到视口后单独挂到 body。 */
  private openPanel(): void {
    const anchor = this.trigger.getBoundingClientRect();
    const rightmost = window.innerWidth - PANEL_WIDTH - VIEWPORT_GUTTER;
    this.panel.style.left = `${Math.max(VIEWPORT_GUTTER, Math.min(anchor.right - PANEL_WIDTH, rightmost))}px`;
    this.panel.style.top = `${anchor.bottom + PANEL_GAP}px`;
    this.status.textContent = '';
    document.body.appendChild(this.panel);
    this.trigger.setAttribute('aria-expanded', 'true');

    this.panelListeners = new AbortController();
    const { signal } = this.panelListeners;
    const dismissOutside = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !this.container.contains(target) && !this.panel.contains(target)) {
        this.closePanel();
      }
    };
    document.addEventListener('pointerdown', dismissOutside, { capture: true, signal });
    document.addEventListener('focusin', dismissOutside, { signal });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.trigger.focus({ preventScroll: true });
        this.closePanel();
      }
    }, { signal });
    window.addEventListener('scroll', () => this.closePanel(), { capture: true, passive: true, signal });
    window.addEventListener('resize', () => this.closePanel(), { signal });
    this.panel.querySelector('button')?.focus({ preventScroll: true });
  }

  private closePanel(): void {
    this.panelListeners?.abort();
    this.panelListeners = undefined;
    this.panel.remove();
    this.trigger.setAttribute('aria-expanded', 'false');
  }

  /** 服务端确认写入后再更新角标，失败时保留原来的显示。 */
  private async submit(isAiScript: boolean): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.status.textContent = '';
    this.panel.setAttribute('aria-busy', 'true');
    const success = await CloudCacheService.saveRemoteAIScriptLabel(this.part, isAiScript);
    this.panel.removeAttribute('aria-busy');
    this.saving = false;

    if (!success) {
      this.status.textContent = '提交失败，请重试';
      return;
    }
    this.showLabel(isAiScript);
    if (this.panel.contains(document.activeElement)) this.trigger.focus({ preventScroll: true });
    this.closePanel();
  }
}
