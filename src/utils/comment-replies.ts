/** 评论接口数据与跨脚本事件。UID、评论编号和投稿编号均使用字符串。 */
export const COMMENT_RULES_EVENT = 'videoadguard:comment-rules';
export const COMMENT_INDEX_EVENT = 'videoadguard:comment-index';
export const COMMENT_IDENTITY_REQUEST = 'videoadguard:comment-identity-request';
export const COMMENT_IDENTITY_EVENT = 'videoadguard:comment-identity';
export const COMMENT_MENU_CLOSE_EVENT = 'videoadguard:comment-menu-close';

export interface CommentIdentity {
  replyId?: string;
  uid?: string;
}

export interface CommentRules {
  enabled: boolean;
  uids: string[];
}

export function commentId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) ? value : undefined;
}

interface Reply {
  rpid_str?: string;
  rpid?: number;
  mid_str?: string;
  mid?: number;
  member?: { mid?: string };
  replies?: Reply[] | null;
  rcount?: number;
  count?: number;
}

interface ReplyPayload {
  code: number;
  data?: {
    replies?: Reply[] | null;
    top_replies?: Reply[] | null;
    root?: Reply | null;
    top?: { upper?: Reply | null; admin?: Reply | null; vote?: Reply | null } | null;
    upper?: { top?: Reply | null };
  };
}

export function readReplyIdentity(reply: Reply | null | undefined): CommentIdentity {
  return {
    replyId: commentId(reply?.rpid_str ?? reply?.rpid),
    uid: commentId(reply?.mid_str ?? reply?.member?.mid ?? reply?.mid),
  };
}

/** 先记录所有作者，再过滤单条评论。保留带回复的顶层评论和服务端分页信息。 */
export function filterCommentReplies(
  payload: ReplyPayload,
  blocked: ReadonlySet<string>,
  nested: boolean,
): { authors: Array<[string, string]>; changed: boolean } {
  const authors: Array<[string, string]> = [];
  const data = payload?.code === 0 ? payload.data : undefined;
  let changed = false;
  if (!data) return { authors, changed };

  function visit(reply: Reply, isNested: boolean): boolean {
    const { replyId, uid } = readReplyIdentity(reply);
    if (replyId && uid) authors.push([replyId, uid]);
    const canRemove = isNested || (reply.rcount === 0 && !reply.count && !reply.replies?.length);
    if (Array.isArray(reply.replies)) reply.replies = reply.replies.filter(child => visit(child, true));
    if (uid && blocked.has(uid) && canRemove) {
      changed = true;
      return false;
    }
    return true;
  }

  if (data.root) {
    const root = data.root;
    const { replyId, uid } = readReplyIdentity(root);
    if (replyId && uid) authors.push([replyId, uid]);
    if (Array.isArray(root.replies)) root.replies = root.replies.filter(child => visit(child, true));
  }
  if (Array.isArray(data.replies)) data.replies = data.replies.filter(reply => visit(reply, nested));
  if (Array.isArray(data.top_replies)) data.top_replies = data.top_replies.filter(reply => visit(reply, false));
  if (data.top) {
    for (const key of ['upper', 'admin', 'vote'] as const) {
      const reply = data.top[key];
      if (reply && !visit(reply, false)) data.top[key] = null;
    }
  }
  if (data.upper?.top && !visit(data.upper.top, false)) data.upper.top = null;
  return { authors, changed };
}
