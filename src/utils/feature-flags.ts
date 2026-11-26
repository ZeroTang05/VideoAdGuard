/**
 * 统一解析插件功能开关。
 * 旧版本只有 enableExtension，新版本首次读取时按旧值迁移到两个独立开关。
 */

export interface FeatureFlags {
  enableAdDetection: boolean;
  enableAiDetection: boolean;
  pluginEnabled: boolean;
}

export function resolveFeatureFlags(settings: Record<string, unknown>): FeatureFlags {
  const legacyEnabled = settings.enableExtension !== false;
  const enableAdDetection = typeof settings.enableAdDetection === 'boolean'
    ? settings.enableAdDetection
    : legacyEnabled;
  const enableAiDetection = typeof settings.enableAiDetection === 'boolean'
    ? settings.enableAiDetection
    : legacyEnabled;

  return {
    enableAdDetection,
    enableAiDetection,
    pluginEnabled: enableAdDetection || enableAiDetection,
  };
}

export async function loadFeatureFlags(): Promise<FeatureFlags> {
  const settings = await chrome.storage.local.get([
    'enableExtension',
    'enableAdDetection',
    'enableAiDetection',
  ]);
  return resolveFeatureFlags(settings as Record<string, unknown>);
}
