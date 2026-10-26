import { LLMProvider, ResolvedLLMSettings, StoredLLMSettings } from './types';

export const DEFAULT_MODEL = '';
export const STORAGE_KEYS = ['provider', 'baseUrl', 'apiUrl', 'apiKey', 'model', 'enableLocalOllama'] as const;

export function resolveLLMSettings(settings: StoredLLMSettings): ResolvedLLMSettings {
  const provider = requireExplicitProvider(settings.provider);
  const baseUrl = resolveBaseUrl(settings, provider);
  const apiUrl = buildApiUrl(provider, baseUrl);

  return {
    provider,
    apiUrl,
    apiKey: settings.apiKey || null,
    model: (settings.model || DEFAULT_MODEL).trim(),
    baseUrl,
  };
}

function requireExplicitProvider(provider: StoredLLMSettings['provider']): LLMProvider {
  if (provider === 'openai' || provider === 'anthropic' || provider === 'custom_fetch' || provider === 'system_one') {
    return provider;
  }
  throw new Error('未设置SDK类型，请在设置中显式选择后重试');
}

export function buildApiUrl(provider: LLMProvider, baseUrl: string): string {
  const normalizedBaseUrl = trimTrailingSlash(baseUrl);
  if (!normalizedBaseUrl) {
    return '';
  }

  switch (provider) {
    case 'system_one':
      return normalizedBaseUrl.endsWith('/v1')
        ? `${normalizedBaseUrl}/systemone`
        : `${normalizedBaseUrl}/v1/systemone`;
    case 'anthropic':
      return normalizedBaseUrl.endsWith('/v1')
        ? `${normalizedBaseUrl}/messages`
        : `${normalizedBaseUrl}/v1/messages`;
    case 'custom_fetch': {
      const endpointKind = detectCustomFetchEndpointKind(normalizedBaseUrl);
      if (endpointKind === 'full') return normalizedBaseUrl;
      if (endpointKind === 'openai') return `${normalizedBaseUrl}/chat/completions`;
      return normalizedBaseUrl.endsWith('/api')
        ? `${normalizedBaseUrl}/chat`
        : `${normalizedBaseUrl}/api/chat`;
    }
    case 'openai':
    default:
      return `${normalizedBaseUrl}/chat/completions`;
  }
}

function detectCustomFetchEndpointKind(baseUrl: string): 'full' | 'openai' | 'ollama' {
  if (
    baseUrl.endsWith('/api/chat') ||
    baseUrl.endsWith('/v1/chat/completions') ||
    baseUrl.endsWith('/chat/completions') ||
    baseUrl.endsWith('/v1/messages') ||
    baseUrl.endsWith('/messages')
  ) {
    return 'full';
  }

  if (baseUrl.endsWith('/v1') || baseUrl.includes('/v1/')) {
    return 'openai';
  }

  return 'ollama';
}

function resolveBaseUrl(settings: StoredLLMSettings, provider: LLMProvider): string {
  if (settings.baseUrl) {
    const normalizedBaseUrl = trimTrailingSlash(settings.baseUrl);
    // Anthropic/OpenAI SDK 会自动追加 endpoint，若用户填了完整路径需回退到 base URL。
    return provider === 'custom_fetch'
      ? normalizedBaseUrl
      : normalizeBaseUrl(normalizedBaseUrl, provider);
  }
  if (settings.apiUrl) return normalizeBaseUrl(settings.apiUrl, provider);
  return '';
}

function normalizeBaseUrl(apiUrl: string, provider: LLMProvider): string {
  switch (provider) {
    case 'system_one':
      return trimSuffixes(apiUrl, ['/systemone']);
    case 'anthropic':
      return trimSuffixes(apiUrl, ['/v1/messages', '/messages']);
    case 'custom_fetch':
      return trimSuffixes(apiUrl, ['/api/chat', '/v1/chat/completions', '/chat/completions', '/messages', '/v1/messages']);
    case 'openai':
    default:
      return trimSuffixes(apiUrl, ['/chat/completions', '/responses']);
  }
}

function trimSuffixes(url: string, suffixes: string[]): string {
  for (const suffix of suffixes) {
    if (url.endsWith(suffix)) {
      return url.slice(0, -suffix.length);
    }
  }
  return url;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
