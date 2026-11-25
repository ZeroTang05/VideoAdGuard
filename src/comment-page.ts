/** 页面脚本复用 B 站发出的评论请求，过滤发生在评论组件读取响应之前。 */
import {
  COMMENT_IDENTITY_EVENT, COMMENT_IDENTITY_REQUEST, COMMENT_INDEX_EVENT, COMMENT_MENU_CLOSE_EVENT, COMMENT_RULES_EVENT,
  CommentRules, commentId, filterCommentReplies, readReplyIdentity,
} from './utils/comment-replies';

const paths = new Set(['/x/v2/reply', '/x/v2/reply/main', '/x/v2/reply/wbi/main', '/x/v2/reply/reply']);
const fetchPage = window.fetch;
let enabled = false;
let blocked = new Set<string>();

document.addEventListener(COMMENT_RULES_EVENT, event => {
  const rules = JSON.parse((event as CustomEvent<string>).detail) as CommentRules;
  enabled = rules.enabled;
  blocked = new Set(rules.uids);
});

// 组件的数据属性在网页脚本环境里可读，只把评论编号和作者 UID 传给扩展。
document.addEventListener(COMMENT_IDENTITY_REQUEST, event => {
  const element = event.composedPath()[0];
  if (!(element instanceof HTMLElement) || !element.matches('bili-comment-renderer,bili-comment-reply-renderer')) return;
  const identity = readReplyIdentity((element as HTMLElement & { data?: Parameters<typeof readReplyIdentity>[0] }).data);
  element.dispatchEvent(new CustomEvent(COMMENT_IDENTITY_EVENT, { detail: JSON.stringify(identity) }));
});

// 在页面环境操作原生组件的菜单状态，保留再次打开菜单的行为。
document.addEventListener(COMMENT_MENU_CLOSE_EVENT, event => {
  const actions = event.composedPath()[0];
  if (actions instanceof HTMLElement && actions.localName === 'bili-comment-action-buttons-renderer'
      && 'showMoreMenu' in actions) actions.showMoreMenu = false;
});

/** 保留页面和其他扩展会读取的原响应地址与跳转信息。 */
function preserveResponseInfo(replacement: Response, original: Response): Response {
  for (const key of ['url', 'type', 'redirected'] as const) {
    Object.defineProperty(replacement, key, { value: original[key] });
  }
  const clone = replacement.clone.bind(replacement);
  Object.defineProperty(replacement, 'clone', { value: () => preserveResponseInfo(clone(), original) });
  return replacement;
}

window.fetch = async function (input, init) {
  const pending = fetchPage.call(window, input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : input, location.href);
  } catch {
    return pending;
  }
  const aid = commentId(url?.searchParams.get('oid'));
  if (method.toUpperCase() !== 'GET' || url.origin !== 'https://api.bilibili.com'
      || !paths.has(url.pathname) || url.searchParams.get('type') !== '1' || !aid) return pending;

  const videoPath = location.pathname;
  const response = await pending;
  if (!response.ok || !enabled || location.pathname !== videoPath) return response;

  // 页面继续使用原始响应时，读取副本可避免消耗原响应的数据流。
  try {
    const payload = await response.clone().json();
    if (!enabled || location.pathname !== videoPath) return response;
    const { authors, changed } = filterCommentReplies(payload, blocked, url.pathname.endsWith('/reply/reply'));
    if (authors.length) {
      document.dispatchEvent(new CustomEvent(COMMENT_INDEX_EVENT, { detail: JSON.stringify({ aid, authors }) }));
    }
    if (!changed) return response;

    const headers = new Headers(response.headers);
    for (const name of ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest']) headers.delete(name);
    return preserveResponseInfo(new Response(JSON.stringify(payload), {
      headers, status: response.status, statusText: response.statusText,
    }), response);
  } catch (error) {
    console.warn('【VideoAdGuard】评论响应处理失败', error);
    return response;
  }
};
