/** 在 B 站原生评论菜单中标注疑似 AI 评论，并同步本地与共享屏蔽名单。 */
import { BilibiliService } from './services/bilibili';
import { CloudCacheService } from './services/cloud-cache';
import {
  COMMENT_IDENTITY_EVENT, COMMENT_IDENTITY_REQUEST, COMMENT_INDEX_EVENT, COMMENT_MENU_CLOSE_EVENT, COMMENT_RULES_EVENT,
  CommentIdentity, commentId,
} from './utils/comment-replies';

const LOCAL_PREFIX = 'aiCommentBlocked:';
const SHARED_KEY = 'aiCommentSharedUids';
const HIDDEN = 'data-vag-ai-comment-hidden';
const NATIVE_ROW = 'bili-comment-renderer,bili-comment-reply-renderer';
const ROW = `${NATIVE_ROW},.root-reply-container,.sub-reply-item,.bb-comment .list-item,.bb-comment .reply-item`;
const MENU_BUTTON_STYLE = 'display:block;width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:inherit;cursor:inherit;';

let enabled = false;
let scanFrame = 0;
let videoPath = location.pathname;
let commentArea: HTMLElement | null = null;
let local = new Set<string>();
let shared = new Set<string>();
const authors = new Map<string, Map<string, string>>();
const menuItems = new Map<HTMLElement, HTMLLIElement>();
const resolvingAuthors = new WeakSet<HTMLElement>();
const hidden = new Set<HTMLElement>();
const styled = new WeakSet<Document | ShadowRoot>();
const observed = new Set<ShadowRoot>();
const observer = new MutationObserver(scheduleScan);
const pageObserver = new MutationObserver(() => {
  if (location.pathname !== videoPath || findCommentArea() !== commentArea) scheduleScan();
});
const status = document.createElement('div');
status.style.cssText = 'color:var(--text2,#61666d);font-size:12px;';
status.setAttribute('role', 'status');

/** 同步页面脚本所需的名单和开关，云端请求始终从扩展环境发出。 */
function publishRules(): void {
  document.dispatchEvent(new CustomEvent(COMMENT_RULES_EVENT, {
    detail: JSON.stringify({ enabled, uids: [...new Set([...local, ...shared])] }),
  }));
  scheduleScan();
}

function updateRoute(): void {
  if (location.pathname === videoPath) return;
  videoPath = location.pathname;
  authors.clear();
  status.textContent = '';
}

function findCommentArea(): HTMLElement | null {
  if (!enabled || !location.pathname.startsWith('/video/')) return null;
  return document.getElementById('commentapp') ?? document.getElementById('comment');
}

document.addEventListener(COMMENT_INDEX_EVENT, event => {
  if (!enabled) return;
  updateRoute();
  const { aid, authors: entries } = JSON.parse((event as CustomEvent<string>).detail) as {
    aid: string; authors: Array<[string, string]>;
  };
  if (!commentId(aid) || !Array.isArray(entries)) return;
  let index = authors.get(aid);
  if (!index) authors.set(aid, index = new Map());
  for (const [replyId, uid] of entries) {
    if (commentId(replyId) && commentId(uid)) index.set(replyId, uid);
  }
  scheduleScan();
});

function scheduleScan(): void {
  if (!scanFrame) scanFrame = requestAnimationFrame(scan);
}

/** 从当前评论组件读取数据，并在作者区用主页链接或属性识别旧版评论。 */
function identify(row: HTMLElement): CommentIdentity {
  const root = row.shadowRoot ?? row;
  const user = root.querySelector('bili-comment-user-info')?.shadowRoot;
  const author = user?.querySelector('#user-name') ?? root.querySelector(
    '#user-avatar,.user-info .user-name,.user-name,.sub-user-name,.user .name,.user-face,.root-reply-avatar',
  );
  const link = author?.matches('a') ? author : author?.querySelector('a');
  const href = link?.getAttribute('href');
  const uid = commentId(author?.getAttribute('data-user-profile-id') ?? author?.getAttribute('data-user-id')
    ?? author?.getAttribute('data-mid') ?? link?.getAttribute('data-user-id'))
    ?? commentId(href?.match(/^(?:https?:)?\/\/space\.bilibili\.com\/([1-9]\d*)(?:[/?#]|$)/)?.[1]);
  const replyId = commentId(row.getAttribute('data-rpid') ?? row.getAttribute('data-id')
    ?? root.querySelector('.root-reply-avatar[data-root-reply-id]')?.getAttribute('data-root-reply-id'));
  if (!row.matches(NATIVE_ROW)) return { uid, replyId };

  let identity: CommentIdentity = {};
  const readIdentity = (event: Event) => {
    identity = JSON.parse((event as CustomEvent<string>).detail) as CommentIdentity;
  };
  row.addEventListener(COMMENT_IDENTITY_EVENT, readIdentity);
  // dispatchEvent 同步执行，组件可能尚未渲染头像，此时仍可读取它持有的数据。
  row.dispatchEvent(new Event(COMMENT_IDENTITY_REQUEST, { bubbles: true, composed: true }));
  row.removeEventListener(COMMENT_IDENTITY_EVENT, readIdentity);
  return { uid: uid ?? commentId(identity.uid), replyId: replyId ?? commentId(identity.replyId) };
}

function currentAid(): string | undefined {
  const params = commentArea?.querySelector('bili-comments')?.getAttribute('data-params')?.split(',');
  return params?.[0] === '1' ? commentId(params[1]) : undefined;
}

/** 旧版普通 HTML 把部分回复放在顶层节点里，折叠它主体的同时保留回复入口。 */
function rowBody(row: HTMLElement): HTMLElement[] {
  if (!row.matches('.bb-comment .list-item')) return [row];
  return Array.from(row.querySelectorAll<HTMLElement>('.user,.text,.text-con,.info,.user-face'))
    .filter(element => element.closest('.list-item') === row && !element.closest('.reply-box,.reply-item'));
}

function hide(row: HTMLElement): void {
  const root = row.getRootNode() as Document | ShadowRoot;
  if (!styled.has(root)) {
    const style = document.createElement('style');
    style.textContent = `[${HIDDEN}]{display:none!important}`;
    if (root instanceof Document) root.head.append(style);
    else root.append(style);
    styled.add(root);
  }
  if (!row.hasAttribute(HIDDEN)) row.setAttribute(HIDDEN, '');
  hidden.add(row);
}

function updateRow(row: HTMLElement, uid?: string): void {
  const blocked = uid !== undefined && (local.has(uid) || shared.has(uid));
  for (const body of rowBody(row)) {
    if (blocked) hide(body);
    else if (body.hasAttribute(HIDDEN)) {
      body.removeAttribute(HIDDEN);
      hidden.delete(body);
    }
  }
  if (row.matches(NATIVE_ROW)) updateMenu(row, blocked);
}

/** 主评论和楼中楼共用原生操作组件。菜单重新渲染后补上该项。 */
function updateMenu(row: HTMLElement, blocked: boolean): void {
  const actions = row.shadowRoot?.querySelector('bili-comment-action-buttons-renderer');
  const options = actions?.shadowRoot?.querySelector('bili-comment-menu')?.shadowRoot?.querySelector('#options');
  const previous = menuItems.get(row);
  if (!blocked && previous && previous.parentElement === options) return;
  if (previous) {
    previous.remove();
    menuItems.delete(row);
  }
  if (blocked || !actions || !options) return;

  const item = document.createElement('li');
  const choice = document.createElement('button');
  choice.type = 'button';
  choice.textContent = '疑似 AI 评论';
  choice.style.cssText = MENU_BUTTON_STYLE;
  item.append(choice);
  item.addEventListener('click', event => {
    if (!event.isTrusted) return;
    event.stopPropagation();
    actions.dispatchEvent(new Event(COMMENT_MENU_CLOSE_EVENT, { bubbles: true, composed: true }));
    void submit(row);
  });
  options.append(item);
  menuItems.set(row, item);
}

/** 逐层观察开放的 Shadow DOM，评论排序、翻页和展开回复时重新识别。 */
function scan(): void {
  scanFrame = 0;
  updateRoute();
  const area = findCommentArea();
  if (area !== commentArea) {
    status.remove();
    for (const item of menuItems.values()) item.remove();
    menuItems.clear();
    commentArea = area;
    observer.disconnect();
    observed.clear();
    if (area) observer.observe(area, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-params', 'data-user-id', 'data-mid', 'href'] });
  }
  if (!area) {
    for (const row of hidden) row.removeAttribute(HIDDEN);
    hidden.clear();
    return;
  }
  if (!status.isConnected) area.prepend(status);

  const aid = currentAid();
  const index = aid ? authors.get(aid) : undefined;
  function walk(node: Element | ShadowRoot): void {
    for (const element of Array.from(node.children)) {
      if (element === status || !(element instanceof HTMLElement)) continue;
      if (element.matches(ROW)) {
        const { uid, replyId } = identify(element);
        updateRow(element, uid ?? (replyId ? index?.get(replyId) : undefined));
      }
      if (element.shadowRoot && element.localName.startsWith('bili-comment')) {
        if (!observed.has(element.shadowRoot)) {
          observer.observe(element.shadowRoot, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-params', 'data-user-profile-id', 'href'] });
          observed.add(element.shadowRoot);
        }
        walk(element.shadowRoot);
      }
      if (!element.matches(`${NATIVE_ROW},.sub-reply-item`) && element.children.length) walk(element);
    }
  }
  walk(area);
  for (const row of hidden) if (!row.isConnected) hidden.delete(row);
  for (const row of menuItems.keys()) if (!row.isConnected) menuItems.delete(row);
  if ([...observed].some(root => !root.host.isConnected)) {
    observer.disconnect();
    observer.observe(area, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-params', 'data-user-id', 'data-mid', 'href'] });
    observed.clear();
    scheduleScan();
  }
}

async function submit(row: HTMLElement): Promise<void> {
  if (!enabled || resolvingAuthors.has(row)) return;
  resolvingAuthors.add(row);
  const path = location.pathname;
  status.textContent = '';
  try {
    const { replyId, uid: directUid } = identify(row);
    const aid = currentAid();
    let uid = directUid ?? (aid && replyId ? authors.get(aid)?.get(replyId) : undefined);
    if (!uid && replyId) {
      const bvid = path.match(/^\/video\/(BV[0-9A-Za-z]{10})/i)?.[1];
      const resolvedAid = aid ?? (bvid ? commentId((await BilibiliService.getVideoInfo(bvid)).aid) : undefined);
      if (resolvedAid) uid = await BilibiliService.getCommentAuthor(resolvedAid, replyId);
    }
    if (!uid) throw new Error('评论缺少可核实的作者 UID');
    if (local.has(uid) || shared.has(uid)) return;

    local.add(uid);
    publishRules();
    if (location.pathname === path) status.textContent = '已屏蔽此作者';
    void chrome.storage.local.set({ [LOCAL_PREFIX + uid]: true }).catch(error => {
      console.warn('【VideoAdGuard】本地屏蔽保存失败', error);
    });
    void CloudCacheService.reportAiComment(uid);
  } catch (error) {
    console.warn('【VideoAdGuard】评论标注失败', error);
    if (location.pathname === path) status.textContent = '无法识别评论作者';
  } finally {
    resolvingAuthors.delete(row);
  }
}

/** 初次打开使用本机名单，同时获取云端已发布的 UID。 */
void (async () => {
  const stored = await chrome.storage.local.get(null);
  enabled = stored.enableExtension !== false;
  local = new Set(Object.keys(stored).filter(key => key.startsWith(LOCAL_PREFIX) && stored[key] === true)
    .map(key => key.slice(LOCAL_PREFIX.length)));
  shared = new Set(Array.isArray(stored[SHARED_KEY]) ? stored[SHARED_KEY] : []);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let refresh = false;
    if (changes.enableExtension) {
      enabled = changes.enableExtension.newValue !== false;
      if (enabled) void syncShared();
      refresh = true;
    }
    if (changes[SHARED_KEY]) {
      shared = new Set(changes[SHARED_KEY].newValue ?? []);
      refresh = true;
    }
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(LOCAL_PREFIX)) continue;
      const uid = key.slice(LOCAL_PREFIX.length);
      if (change.newValue === true) local.add(uid);
      else local.delete(uid);
      refresh = true;
    }
    if (refresh) publishRules();
  });
  pageObserver.observe(document, { childList: true, subtree: true });
  window.addEventListener('popstate', scheduleScan);
  publishRules();
  if (enabled) void syncShared();
})().catch(error => console.warn('【VideoAdGuard】评论标注初始化失败', error));

async function syncShared(): Promise<void> {
  try {
    const uids = await CloudCacheService.fetchAiCommentBlocklist();
    if (uids) await chrome.storage.local.set({ [SHARED_KEY]: uids });
  } catch (error) {
    console.warn('【VideoAdGuard】共享评论名单保存失败', error);
  }
}
