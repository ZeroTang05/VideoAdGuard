export type UserErrorContext =
  | 'llm'
  | 'audio'
  | 'settings'
  | 'whitelist'
  | 'detection'
  | 'network'
  | 'generic';

const USER_FACING_ERRORS = [
  '请先配置有效的 Groq API 密钥',
  'API 密钥无效，请检查后重新填写',
  '请先配置有效的 API 密钥',
  '模型不存在或当前接口不支持该模型，请检查模型名称',
  '输入内容过长，请减少内容后重试',
  '账户额度不足，请充值或更换接口',
  '当前接口或模型不支持该请求参数，请更换模型或接口',
  '接口地址无效，请检查 Base URL 和 SDK 选择',
  '鉴权失败，请检查 API 密钥和接口权限',
  '请求过于频繁或额度不足，请稍后再试',
  '模型上游服务暂时不可用，请稍后重试',
  '服务暂时不可用，请稍后重试',
  '网络请求失败，请检查地址、网络或代理设置',
  '网络请求失败，请稍后重试',
  '音频文件过大，暂时无法识别',
  '音频处理失败，请稍后重试',
  '模型未返回有效内容，请更换模型或稍后重试',
  '模型返回结果格式异常，请更换模型或稍后重试',
  '未找到该 UP 主，请检查 UID 是否正确',
  '请求被服务端拒绝，请稍后重试或检查账号权限',
  '模型请求失败，请检查配置后重试',
  '音频识别失败，请稍后重试',
  '设置保存失败，请稍后重试',
  '白名单操作失败，请稍后重试',
  '模型接口调用失败，请检查 Base URL、API 密钥和模型名称',
  '模型分析未完成，请检查模型配置、网络或模型名称',
  '未找到视频ID，请检查视频链接是否正确',
  '操作失败，请稍后重试',
];

const USER_FACING_ERROR_PREFIXES = [
  '请先配置有效的',
  'API 密钥无效',
  '模型不存在或当前接口不支持该模型',
  '输入内容过长',
  '账户额度不足',
  '当前接口或模型不支持该请求参数',
  '接口地址无效',
  '鉴权失败',
  '请求过于频繁或额度不足',
  '模型上游服务暂时不可用',
  '服务暂时不可用',
  '网络请求失败',
  '音频文件过大',
  '音频处理失败',
  '模型未返回有效内容',
  '模型返回结果格式异常',
  '未找到该 UP 主',
  '请求被服务端拒绝',
  '模型请求失败',
  '音频识别失败',
  '设置保存失败',
  '白名单操作失败',
  '模型接口调用失败',
  '模型分析未完成',
  '操作失败',
];

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message || String(error);
  }

  return String(error || '');
}

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractApiErrorMessage(payload: unknown): string | null {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed || null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const message = extractApiErrorMessage(item);
      if (message) {
        return message;
      }
    }
    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  const directKeys = ['message', 'msg', 'errmsg', 'error_msg', 'detail', 'title', 'description'];
  for (const key of directKeys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const nestedKeys = ['error', 'details'];
  for (const key of nestedKeys) {
    const value = payload[key];
    const nestedMessage = extractApiErrorMessage(value);
    if (nestedMessage) {
      return nestedMessage;
    }
  }

  return null;
}

export async function createHttpError(response: Response, fallbackMessage: string): Promise<Error> {
  const contentType = response.headers.get('content-type') || '';
  let bodyText = '';
  let bodyMessage: string | null = null;

  try {
    if (contentType.includes('application/json')) {
      const data = await response.json();
      bodyMessage = extractApiErrorMessage(data);
      if (!bodyMessage && data !== undefined) {
        bodyText = JSON.stringify(data);
      }
    } else {
      bodyText = (await response.text()).trim();
      bodyMessage = extractApiErrorMessage(bodyText);
    }
  } catch {
    bodyText = '';
  }

  const statusPart = `${response.status} ${response.statusText}`.trim();
  const detail = bodyMessage || bodyText;
  const parts = [fallbackMessage, statusPart, detail].filter(Boolean);
  return new Error(parts.join(' - '));
}

function getDefaultUserError(context: UserErrorContext): string {
  switch (context) {
    case 'llm':
      return '模型接口调用失败，请检查 Base URL、API 密钥和模型名称';
    case 'audio':
      return '音频识别失败，请稍后重试';
    case 'settings':
      return '设置保存失败，请稍后重试';
    case 'whitelist':
      return '白名单操作失败，请稍后重试';
    case 'detection':
      return '模型分析未完成，请检查模型配置、网络或模型名称';
    case 'network':
      return '网络请求失败，请稍后重试';
    default:
      return '操作失败，请稍后重试';
  }
}

export function normalizeErrorForUser(error: unknown, context: UserErrorContext = 'generic'): string {
  const rawText = getErrorText(error).trim();
  const text = rawText.toLowerCase();

  if (!rawText) {
    return getDefaultUserError(context);
  }

  if (USER_FACING_ERRORS.includes(rawText) || USER_FACING_ERROR_PREFIXES.some((prefix) => rawText.startsWith(prefix))) {
    return rawText;
  }

  if (includesAny(text, ['未配置groq api密钥', 'groq api密钥'])) {
    return '请先配置有效的 Groq API 密钥';
  }

  if (includesAny(text, ['incorrect api key', 'invalid_api_key', 'invalid api key', 'api key is invalid', 'api key not valid'])) {
    return 'API 密钥无效，请检查后重新填写';
  }

  if (includesAny(text, ['未设置api密钥', 'api key', 'unauthorized', 'authentication', 'invalid x-api-key'])) {
    return '请先配置有效的 API 密钥';
  }

  if (includesAny(text, ['model not found', 'no such model', 'unknown model', 'does not exist', 'model_not_found', 'invalid model'])) {
    return '模型不存在或当前接口不支持该模型，请检查模型名称';
  }

  if (includesAny(text, ['max_tokens_exceeded', 'context length', 'maximum context length', 'prompt is too long', 'token limit', 'too many tokens'])) {
    return '输入内容过长，请减少内容后重试';
  }

  if (includesAny(text, ['insufficient_quota', 'credit balance', '余额不足', '额度不足', 'insufficient balance'])) {
    return '账户额度不足，请充值或更换接口';
  }

  if (includesAny(text, ['unsupported parameter', 'invalid_request_error', 'does not support', 'response_format', 'unsupported value', 'bad_request_error'])) {
    return '当前接口或模型不支持该请求参数，请更换模型或接口';
  }

  if (includesAny(text, ['base url', 'unsupported protocol', 'invalid url', 'only absolute urls are supported'])) {
    return '接口地址无效，请检查 Base URL 和 SDK 选择';
  }

  if (includesAny(text, ['404', 'not found'])) {
    return '接口地址无效，请检查 Base URL 和 SDK 选择';
  }

  if (includesAny(text, ['401', '403', 'forbidden'])) {
    return '鉴权失败，请检查 API 密钥和接口权限';
  }

  if (includesAny(text, ['429', 'rate limit', 'too many requests', 'quota'])) {
    return '请求过于频繁或额度不足，请稍后再试';
  }

  if (includesAny(text, ['529', 'overloaded', 'capacity', '500', '502', '503', '504', 'bad gateway', 'service unavailable'])) {
    return '模型上游服务暂时不可用，请稍后重试';
  }

  if (includesAny(text, ['timeout', 'timed out', 'failed to fetch', 'fetch failed', 'econnrefused', 'enotfound', 'networkerror', 'connection error', 'apiconnectionerror', 'socket hang up'])) {
    return '网络请求失败，请检查地址、网络或代理设置';
  }

  if (includesAny(text, ['音频文件过大', 'file too large'])) {
    return '音频文件过大，暂时无法识别';
  }

  if (includesAny(text, ['未提供有效的音频数据', '无法获取音频数据', '无法获取文件流', '音频下载失败', '未知格式'])) {
    return '音频处理失败，请稍后重试';
  }

  if (includesAny(text, ['未返回文本内容'])) {
    return '模型未返回有效内容，请更换模型或稍后重试';
  }

  if (includesAny(text, ['ai返回数据格式错误', '返回数据格式错误', '广告时间段格式错误', '结果格式异常'])) {
    return '模型返回结果格式异常，请更换模型或稍后重试';
  }

  if (includesAny(text, ['账号不存在', 'uid不存在', 'user not found'])) {
    return '未找到该 UP 主，请检查 UID 是否正确';
  }

  if (includesAny(text, ['请求被拦截', '风控', 'csrf', 'permission denied'])) {
    return '请求被服务端拒绝，请稍后重试或检查账号权限';
  }

  if (includesAny(text, ['未找到视频id', '视频id'])) {
    return '未找到视频ID，请检查视频链接是否正确';
  }

  return getDefaultUserError(context);
}
