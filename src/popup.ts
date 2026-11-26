export { };
import { WhitelistService } from './services/whitelist';
import { BilibiliService } from './services/bilibili';
import { buildApiUrl, resolveLLMSettings } from './services/llm/config';
import { LLMProvider, StoredLLMSettings } from './services/llm/types';
import { normalizeErrorForUser } from './utils/errors';
import { DEBUG_MODE_STORAGE_KEY } from './utils/logger';
import { isBilibiliVideoPage } from './utils/video-page';
import { findSystemOnePreset, SYSTEM_ONE_PRESETS } from './services/llm/system-one-presets';
import {
  decryptSecret,
  decryptSecretMap,
  encryptSecret,
  encryptSecretMap,
  isEncryptedSecret,
} from './services/secret-storage';

interface BaseUrlPreset {
  name: string;
  baseUrl: string;
  actionLabel: string;
  actionUrl: string;
}

interface SDKPreset {
  value: LLMProvider;
  label: string;
}

const SDK_OPTIONS: SDKPreset[] = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic 兼容' },
  { value: 'system_one', label: 'System One' },
  { value: 'custom_fetch', label: '自定义 Fetch' },
];

const SDK_PRESETS: Record<LLMProvider, BaseUrlPreset[]> = {
  system_one: SYSTEM_ONE_PRESETS,
  openai: [
    { name: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/v1', actionLabel: '控制台', actionUrl: 'https://vercel.com/ai-gateway' },
    { name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/inference/openai/v1', actionLabel: '控制台', actionUrl: 'https://opencode.ai/auth' },
    { name: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', actionLabel: '注册', actionUrl: 'https://www.bigmodel.cn/glm-coding?ic=NZ1MQISIX0' },
    { name: '智谱 Coding Plan', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4 ', actionLabel: '注册', actionUrl: 'https://www.bigmodel.cn/glm-coding?ic=NZ1MQISIX0' },
    { name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', actionLabel: '注册', actionUrl: 'https://platform.minimaxi.com/subscribe/token-plan?code=FapfOonxo7&source=link' },
    { name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', actionLabel: '注册', actionUrl: 'https://platform.moonshot.cn/' },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', actionLabel: '注册', actionUrl: 'https://platform.deepseek.com/api_keys' },
    { name: 'Xiaomi MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', actionLabel: '注册', actionUrl: 'https://platform.xiaomimimo.com?ref=HFFE2V' },
    { name: '硅基流动', baseUrl: 'https://api.siliconflow.com/v1', actionLabel: '注册', actionUrl: 'https://cloud.siliconflow.cn/i/VWOdVvvM' },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', actionLabel: '注册', actionUrl: 'https://openrouter.ai/' },
    { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', actionLabel: '注册', actionUrl: 'https://console.groq.com/keys' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', actionLabel: '注册', actionUrl: 'https://openai.com/api/' },
    { name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', actionLabel: '注册', actionUrl: 'https://aistudio.google.com/' },
    { name: 'Grok', baseUrl: 'https://api.x.ai/v1', actionLabel: '注册', actionUrl: 'https://console.x.ai/' },
    { name: '腾讯混元', baseUrl: 'https://tokenhub.tencentmaas.com/v1', actionLabel: '注册', actionUrl: 'https://curl.qcloud.com/xyTqcIlB' },
    { name: '腾讯云 Coding Plan', baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/v3', actionLabel: '注册', actionUrl: 'https://curl.qcloud.com/xyTqcIlB' },
    { name: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', actionLabel: '注册', actionUrl: 'https://www.aliyun.com/minisite/goods?userCode=e9b0x8ku' },
    { name: '阿里云 Coding Plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', actionLabel: '注册', actionUrl: 'https://www.aliyun.com/minisite/goods?userCode=e9b0x8ku' },
    { name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', actionLabel: '注册', actionUrl: 'https://volcengine.com/L/8ziM51O_5WU/' },
    { name: '火山 Coding Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', actionLabel: '注册', actionUrl: 'https://volcengine.com/L/8ziM51O_5WU/' },
    { name: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1', actionLabel: '注册', actionUrl: 'https://platform.stepfun.com/' },
    { name: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2', actionLabel: '注册', actionUrl: 'https://cloud.baidu.com/product-s/qianfan_home' },
    { name: '百度 Coding Plan', baseUrl: 'https://qianfan.baidubce.com/v2/coding', actionLabel: '注册', actionUrl: 'https://cloud.baidu.com/product-s/qianfan_home' },
    { name: '302.AI', baseUrl: 'https://api.302.ai/v1', actionLabel: '注册', actionUrl: 'https://share.302.ai/ckUgCA' },
    { name: 'Requesty API', baseUrl: 'https://router.requesty.ai/v1', actionLabel: '注册', actionUrl: 'https://app.requesty.ai/join?ref=d9bb6cf2' },
  ],
  anthropic: [
    { name: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh', actionLabel: '控制台', actionUrl: 'https://vercel.com/ai-gateway' },
    { name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/inference/anthropic/v1', actionLabel: '控制台', actionUrl: 'https://opencode.ai/auth' },
    { name: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/anthropic', actionLabel: '注册', actionUrl: 'https://www.bigmodel.cn/glm-coding?ic=NZ1MQISIX0' },
    { name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/anthropic', actionLabel: '注册', actionUrl: 'https://platform.minimaxi.com/subscribe/token-plan?code=FapfOonxo7&source=link' },
    { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', actionLabel: '注册', actionUrl: 'https://console.anthropic.com/settings/keys' },
    { name: '小米 Token Plan', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', actionLabel: '注册', actionUrl: 'https://platform.xiaomimimo.com?ref=HFFE2V' },
    { name: '腾讯云 Coding Plan', baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/anthropic', actionLabel: '注册', actionUrl: 'https://curl.qcloud.com/xyTqcIlB' },
    { name: '阿里云 Coding Plan', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic', actionLabel: '注册', actionUrl: 'https://www.aliyun.com/minisite/goods?userCode=e9b0x8ku' },
    { name: '火山 Coding Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', actionLabel: '注册', actionUrl: 'https://volcengine.com/L/8ziM51O_5WU/' },
    { name: '百度 Coding Plan', baseUrl: 'https://qianfan.baidubce.com/anthropic/coding', actionLabel: '注册', actionUrl: 'https://cloud.baidu.com/product-s/qianfan_home' },
  ],
  custom_fetch: [
    { name: 'Ollama 本地', baseUrl: 'http://localhost:11434', actionLabel: '下载', actionUrl: 'https://ollama.com/' },
    { name: 'LM Studio 本地', baseUrl: 'http://localhost:1234/v1', actionLabel: '下载', actionUrl: 'https://lmstudio.ai/' },
    { name: 'vLLM 本地', baseUrl: 'http://localhost:8000/v1', actionLabel: '文档', actionUrl: 'https://docs.vllm.ai/' },
    { name: 'llama.cpp 本地', baseUrl: 'http://localhost:8080/v1', actionLabel: '文档', actionUrl: 'https://github.com/ggerganov/llama.cpp' },
    { name: 'LocalAI 本地', baseUrl: 'http://localhost:8080/v1', actionLabel: '文档', actionUrl: 'https://localai.io/' },
    { name: 'Xinference 本地', baseUrl: 'http://localhost:9997/v1', actionLabel: '文档', actionUrl: 'https://inference.readthedocs.io/' },
    { name: 'FastChat 本地', baseUrl: 'http://localhost:8000/v1', actionLabel: '文档', actionUrl: 'https://github.com/lm-sys/FastChat' },
    { name: 'Jan 本地', baseUrl: 'http://localhost:1337/v1', actionLabel: '下载', actionUrl: 'https://jan.ai/' },
    { name: 'One API 本地', baseUrl: 'http://localhost:3000/v1', actionLabel: '文档', actionUrl: 'https://github.com/songquanpeng/one-api' },
  ],
};

document.addEventListener('DOMContentLoaded', async () => {
  const providerInput = document.getElementById('provider') as HTMLInputElement;
  const providerDisplayInput = document.getElementById('providerDisplay') as HTMLInputElement;
  const baseUrlInput = document.getElementById('baseUrl') as HTMLInputElement;
  const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
  const modelInput = document.getElementById('model') as HTMLInputElement;
  const messageDiv = document.getElementById('message') as HTMLDivElement;
  const resultDiv = document.getElementById('result') as HTMLDivElement;
  const enableExtensionCheckbox = document.getElementById('enableExtension') as HTMLInputElement;
  const autoSkipAdCheckbox = document.getElementById('autoSkipAd') as HTMLInputElement;
  const restrictedModeCheckbox = document.getElementById('restrictedMode') as HTMLInputElement;
  const togglePasswordBtn = document.getElementById('toggleApiKey') as HTMLInputElement;
  const groqApiKeyInput = document.getElementById('groqApiKey') as HTMLInputElement;
  const toggleGroqPasswordBtn = document.getElementById('toggleGroqApiKey') as HTMLInputElement;
  const enableAudioTranscriptionCheckbox = document.getElementById('enableAudioTranscription') as HTMLInputElement;
  const enableGroqProxyCheckbox = document.getElementById('enableGroqProxy') as HTMLInputElement;

  const providerDropdown = document.getElementById('providerDropdown') as HTMLButtonElement;
  const providerDropdownMenu = document.getElementById('providerDropdownMenu') as HTMLDivElement;
  const baseUrlDropdown = document.getElementById('baseUrlDropdown') as HTMLButtonElement;
  const baseUrlDropdownMenu = document.getElementById('baseUrlDropdownMenu') as HTMLDivElement;
  const titleElement = document.querySelector('h3') as HTMLHeadingElement | null;

  enableExtensionCheckbox.checked = true;
  autoSkipAdCheckbox.checked = true;

  let apiKeysByBaseUrl: Record<string, string> = {};
  let modelsByBaseUrl: Record<string, string> = {};
  let baseUrlsByProvider: Partial<Record<LLMProvider, string>> = {};
  let activeBaseUrlKey: string | null = null;
  let debugModeEnabled = false;
  let debugClickCount = 0;
  let debugClickTimer: number | null = null;

  function showMessage(text: string, type: 'success' | 'error', autoHideMs: number | null = null) {
    messageDiv.textContent = text;
    messageDiv.className = type;
    messageDiv.style.display = 'block';
    if (autoHideMs) {
      window.setTimeout(() => {
        if (messageDiv.textContent === text) {
          messageDiv.style.display = 'none';
        }
      }, autoHideMs);
    }
  }

  function getSelectedProvider(): LLMProvider {
    return providerInput.value as LLMProvider;
  }

  function setSelectedProvider(provider: LLMProvider) {
    providerInput.value = provider;
    providerDisplayInput.value = SDK_OPTIONS.find((option) => option.value === provider)?.label || provider;
  }

  function normalizeCompleteBaseUrl(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    try {
      const url = new URL(trimmed);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
      const pathname = url.pathname.replace(/\/+$/, '');
      return `${url.protocol}//${url.host}${pathname}`;
    } catch {
      return null;
    }
  }

  function persistCurrentApiKeyBinding() {
    if (!activeBaseUrlKey) return;
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) apiKeysByBaseUrl[activeBaseUrlKey] = apiKey;
    else delete apiKeysByBaseUrl[activeBaseUrlKey];
  }

  function persistCurrentModelBinding() {
    if (!activeBaseUrlKey) return;
    const model = modelInput.value.trim();
    if (model) modelsByBaseUrl[activeBaseUrlKey] = model;
    else delete modelsByBaseUrl[activeBaseUrlKey];
  }

  function persistCurrentBindings() {
    persistCurrentProviderBaseUrl();
    persistCurrentApiKeyBinding();
    persistCurrentModelBinding();
  }

  function getCachedBaseUrl(provider: LLMProvider): string {
    const value = baseUrlsByProvider[provider];
    return typeof value === 'string' ? value : '';
  }

  function persistCurrentProviderBaseUrl(provider: LLMProvider = getSelectedProvider()) {
    const baseUrl = baseUrlInput.value.trim();
    if (baseUrl) {
      baseUrlsByProvider[provider] = baseUrl;
    }
  }

  function switchBaseUrlBinding(savePrevious: boolean = true) {
    if (savePrevious) persistCurrentBindings();
    activeBaseUrlKey = normalizeCompleteBaseUrl(baseUrlInput.value);
    if (!activeBaseUrlKey) {
      apiKeyInput.value = '';
      modelInput.value = '';
      return;
    }
    apiKeyInput.value = apiKeysByBaseUrl[activeBaseUrlKey] || '';
    modelInput.value = modelsByBaseUrl[activeBaseUrlKey] || '';
    if (getSelectedProvider() === 'system_one' && !modelInput.value) {
      modelInput.value = findSystemOnePreset(baseUrlInput.value)?.defaultModel || '';
    }
  }

  function renderBaseUrlPresets(provider: LLMProvider) {
    const presets = SDK_PRESETS[provider];
    baseUrlDropdownMenu.innerHTML = presets
      .map(
        (preset) => `
        <div class="dropdown-item" data-base-url="${preset.baseUrl}">
          <div class="provider-info">
            <span class="provider-name">${preset.name}</span>
            <a href="${preset.actionUrl}" target="_blank" class="register-link">${preset.actionLabel}</a>
          </div>
          <div class="api-url">${preset.baseUrl}</div>
        </div>
      `
      )
      .join('');
  }

  function updateProviderState(provider: LLMProvider, preserveBaseUrl: boolean = false) {
    setSelectedProvider(provider);
    if (!preserveBaseUrl) {
      baseUrlInput.value = getCachedBaseUrl(provider) || (provider === 'system_one' ? 'https://api.typesafe.ai/v1' : '');
    }
    apiKeyInput.placeholder = provider === 'custom_fetch' ? '可留空，本地服务如需鉴权可填写' : '请输入API密钥';
    renderBaseUrlPresets(provider);
  }

  function renderSDKOptions() {
    providerDropdownMenu.innerHTML = SDK_OPTIONS.map((option) => `
      <div class="dropdown-item" data-provider="${option.value}">
        <div class="provider-info">
          <span class="provider-name">${option.label}</span>
        </div>
      </div>
    `).join('');
  }

  async function autoSaveSettings() {
    const provider = getSelectedProvider();
    const baseUrl = baseUrlInput.value.trim();
    const apiUrl = baseUrl ? buildApiUrl(provider, baseUrl) : '';
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim();
    const enableExtension = enableExtensionCheckbox.checked;
    const enableLocalOllama = provider === 'custom_fetch';
    const autoSkipAd = autoSkipAdCheckbox.checked;
    const restrictedMode = restrictedModeCheckbox.checked;
    const groqApiKey = groqApiKeyInput.value.trim();
    const enableAudioTranscription = enableAudioTranscriptionCheckbox.checked;
    const enableGroqProxy = enableAudioTranscription && enableGroqProxyCheckbox ? enableGroqProxyCheckbox.checked : false;

    if (!baseUrl) console.warn('基础地址为空');
    if (provider !== 'custom_fetch' && !apiKey) console.warn('API密钥为空');
    if (!model) console.warn('模型名称为空');

    try {
      persistCurrentProviderBaseUrl(provider);
      persistCurrentBindings();
      const [encryptedApiKey, encryptedApiKeysByBaseUrl, encryptedGroqApiKey] = await Promise.all([
        encryptSecret(apiKey),
        encryptSecretMap(apiKeysByBaseUrl),
        encryptSecret(groqApiKey),
      ]);
      const nextSettings: Record<string, unknown> = {
        provider,
        baseUrl,
        apiKey: encryptedApiKey,
        baseUrlsByProvider,
        apiKeysByBaseUrl: encryptedApiKeysByBaseUrl,
        model,
        modelsByBaseUrl,
        enableExtension,
        enableLocalOllama,
        autoSkipAd,
        restrictedMode,
        groqApiKey: encryptedGroqApiKey,
        enableAudioTranscription,
        enableGroqProxy,
      };

      if (provider === 'custom_fetch') {
        nextSettings.apiUrl = apiUrl;
      }

      await chrome.storage.local.set(nextSettings);
      if (provider !== 'custom_fetch') {
        await chrome.storage.local.remove('apiUrl');
      }
    } catch (error) {
      console.warn('保存设置失败:', error);
      showMessage(normalizeErrorForUser(error, 'settings'), 'error', 2500);
    }
  }

  const allCheckboxes = [
    enableExtensionCheckbox,
    autoSkipAdCheckbox,
    restrictedModeCheckbox,
    enableAudioTranscriptionCheckbox,
    enableGroqProxyCheckbox,
  ].filter(Boolean);

  allCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      autoSaveSettings();
    });
  });

  const allTextInputs = [apiKeyInput, modelInput, groqApiKeyInput].filter(Boolean);
  allTextInputs.forEach((input) => {
    let debounceTimer: number | null = null;
    input.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => autoSaveSettings(), 500);
    });
    input.addEventListener('blur', () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      autoSaveSettings();
    });
  });

  window.addEventListener('beforeunload', autoSaveSettings);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) autoSaveSettings();
  });
  window.addEventListener('blur', autoSaveSettings);

  function initBaseUrlDropdown() {
    baseUrlDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      providerDropdownMenu.classList.remove('show');
      baseUrlDropdownMenu.classList.toggle('show');
    });

    baseUrlDropdownMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      if (target.classList.contains('register-link')) return;
      const dropdownItem = target.closest('.dropdown-item') as HTMLElement;
      if (!dropdownItem) return;
      const baseUrl = dropdownItem.getAttribute('data-base-url');
      if (!baseUrl) return;
      baseUrlInput.value = baseUrl;
      switchBaseUrlBinding(true);
      baseUrlDropdownMenu.classList.remove('show');
      autoSaveSettings();
    });

    document.addEventListener('click', () => {
      baseUrlDropdownMenu.classList.remove('show');
    });
    baseUrlInput.addEventListener('click', (e) => e.stopPropagation());
  }

  function initProviderDropdown() {
    providerDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      providerDropdownMenu.classList.toggle('show');
      baseUrlDropdownMenu.classList.remove('show');
    });

    providerDropdownMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const dropdownItem = target.closest('.dropdown-item') as HTMLElement;
      if (!dropdownItem) return;
      const provider = dropdownItem.getAttribute('data-provider') as LLMProvider | null;
      if (!provider) return;
      persistCurrentBindings();
      updateProviderState(provider);
      switchBaseUrlBinding(false);
      providerDropdownMenu.classList.remove('show');
      autoSaveSettings();
    });

    document.addEventListener('click', () => {
      providerDropdownMenu.classList.remove('show');
    });

    providerDisplayInput.addEventListener('click', (e) => {
      e.stopPropagation();
      providerDropdownMenu.classList.toggle('show');
      baseUrlDropdownMenu.classList.remove('show');
    });
  }

  renderSDKOptions();
  initProviderDropdown();
  initBaseUrlDropdown();

  if (titleElement) {
    titleElement.addEventListener('click', async () => {
      debugClickCount += 1;
      if (debugClickTimer) clearTimeout(debugClickTimer);
      debugClickTimer = window.setTimeout(() => {
        debugClickCount = 0;
        debugClickTimer = null;
      }, 4000);

      if (debugClickCount < 7) return;

      debugClickCount = 0;
      if (debugClickTimer) {
        clearTimeout(debugClickTimer);
        debugClickTimer = null;
      }
      debugModeEnabled = !debugModeEnabled;
      await chrome.storage.local.set({ [DEBUG_MODE_STORAGE_KEY]: debugModeEnabled });
      showMessage(`调试日志已${debugModeEnabled ? '开启' : '关闭'}`, 'success', 2000);
    });
  }

  baseUrlInput.addEventListener('input', () => {
    const normalizedBaseUrl = normalizeCompleteBaseUrl(baseUrlInput.value);
    if (normalizedBaseUrl && normalizedBaseUrl !== activeBaseUrlKey) {
      switchBaseUrlBinding(true);
      autoSaveSettings();
    }
  });

  baseUrlInput.addEventListener('blur', () => {
    const normalizedBaseUrl = normalizeCompleteBaseUrl(baseUrlInput.value);
    if (normalizedBaseUrl && normalizedBaseUrl !== activeBaseUrlKey) {
      switchBaseUrlBinding(true);
      autoSaveSettings();
    }
  });

  if (togglePasswordBtn && apiKeyInput) {
    togglePasswordBtn.addEventListener('click', () => {
      const type = apiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
      apiKeyInput.setAttribute('type', type);
    });
  }

  if (toggleGroqPasswordBtn && groqApiKeyInput) {
    toggleGroqPasswordBtn.addEventListener('click', () => {
      const type = groqApiKeyInput.getAttribute('type') === 'password' ? 'text' : 'password';
      groqApiKeyInput.setAttribute('type', type);
    });
  }

  function updateAudioTranscriptionState(enabled: boolean) {
    document.body.classList.toggle('audio-transcription-enabled', enabled);
    if (!enabled && enableGroqProxyCheckbox) {
      enableGroqProxyCheckbox.checked = false;
    }
  }

  enableAudioTranscriptionCheckbox.addEventListener('change', () => {
    updateAudioTranscriptionState(enableAudioTranscriptionCheckbox.checked);
  });

  const settings = await chrome.storage.local.get([
    'provider',
    'baseUrl',
    'apiUrl',
    'baseUrlsByProvider',
    'apiKey',
    'apiKeysByBaseUrl',
    'model',
    'modelsByBaseUrl',
    'enableExtension',
    'enableLocalOllama',
    'autoSkipAd',
    'restrictedMode',
    DEBUG_MODE_STORAGE_KEY,
    'groqApiKey',
    'enableAudioTranscription',
    'enableGroqProxy',
  ]);

  const decryptedApiKey = await decryptSecret(settings.apiKey);
  const decryptedApiKeysByBaseUrl = await decryptSecretMap(settings.apiKeysByBaseUrl);
  const decryptedGroqApiKey = await decryptSecret(settings.groqApiKey);

  const migratedSecrets: Record<string, unknown> = {};
  if (settings.apiKey && !isEncryptedSecret(settings.apiKey)) {
    migratedSecrets.apiKey = await encryptSecret(decryptedApiKey);
  }
  if (settings.apiKeysByBaseUrl) {
    migratedSecrets.apiKeysByBaseUrl = await encryptSecretMap(decryptedApiKeysByBaseUrl);
  }
  if (settings.groqApiKey && !isEncryptedSecret(settings.groqApiKey)) {
    migratedSecrets.groqApiKey = await encryptSecret(decryptedGroqApiKey);
  }
  if (Object.keys(migratedSecrets).length > 0) {
    await chrome.storage.local.set(migratedSecrets);
  }

  const storedBaseUrlsByProvider = settings.baseUrlsByProvider as Partial<Record<LLMProvider, unknown>> | undefined;
  baseUrlsByProvider = {};
  (['openai', 'anthropic', 'custom_fetch', 'system_one'] as const).forEach((provider) => {
    const value = storedBaseUrlsByProvider?.[provider];
    if (typeof value === 'string' && value.trim()) {
      baseUrlsByProvider[provider] = value.trim();
    }
  });

  apiKeysByBaseUrl = decryptedApiKeysByBaseUrl;
  modelsByBaseUrl = settings.modelsByBaseUrl || {};
  const persistedProvider = settings.provider as StoredLLMSettings['provider'];
  const initialProvider: LLMProvider =
    persistedProvider === 'openai' || persistedProvider === 'anthropic' || persistedProvider === 'custom_fetch' || persistedProvider === 'system_one'
      ? persistedProvider
      : 'openai';
  const resolvedLLMSettings = resolveLLMSettings({
    provider: initialProvider,
    baseUrl: settings.baseUrl,
    apiUrl: settings.apiUrl,
    apiKey: decryptedApiKey,
    model: settings.model,
    enableLocalOllama: settings.enableLocalOllama,
  } as StoredLLMSettings);

  updateProviderState(resolvedLLMSettings.provider, true);
  const persistedBaseUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim() : '';
  const cachedBaseUrl = getCachedBaseUrl(initialProvider);
  const initialBaseUrl = persistedBaseUrl || cachedBaseUrl || resolvedLLMSettings.baseUrl;
  if (initialBaseUrl) {
    baseUrlsByProvider[initialProvider] = initialBaseUrl;
  }
  baseUrlInput.value = initialBaseUrl;
  activeBaseUrlKey = normalizeCompleteBaseUrl(initialBaseUrl);
  if (activeBaseUrlKey && decryptedApiKey && !apiKeysByBaseUrl[activeBaseUrlKey]) {
    apiKeysByBaseUrl[activeBaseUrlKey] = decryptedApiKey;
  }
  if (activeBaseUrlKey && settings.model && !modelsByBaseUrl[activeBaseUrlKey]) {
    modelsByBaseUrl[activeBaseUrlKey] = settings.model;
  }
  if (activeBaseUrlKey && apiKeysByBaseUrl[activeBaseUrlKey]) {
    apiKeyInput.value = apiKeysByBaseUrl[activeBaseUrlKey];
  } else if (decryptedApiKey) {
    apiKeyInput.value = decryptedApiKey;
  }
  if (activeBaseUrlKey && modelsByBaseUrl[activeBaseUrlKey]) {
    modelInput.value = modelsByBaseUrl[activeBaseUrlKey];
  } else if (settings.model) {
    modelInput.value = settings.model;
  } else if (initialProvider === 'system_one') {
    modelInput.value = findSystemOnePreset(initialBaseUrl)?.defaultModel || '';
  }
  if (typeof settings.enableExtension === 'boolean') enableExtensionCheckbox.checked = settings.enableExtension;
  if (typeof settings.autoSkipAd === 'boolean') autoSkipAdCheckbox.checked = settings.autoSkipAd;
  if (settings.restrictedMode) restrictedModeCheckbox.checked = settings.restrictedMode;
  debugModeEnabled = settings[DEBUG_MODE_STORAGE_KEY] === true;
  if (decryptedGroqApiKey) groqApiKeyInput.value = decryptedGroqApiKey;
  if (typeof settings.enableAudioTranscription === 'boolean') {
    enableAudioTranscriptionCheckbox.checked = settings.enableAudioTranscription;
  }
  updateAudioTranscriptionState(enableAudioTranscriptionCheckbox.checked);
  if (enableGroqProxyCheckbox) {
    enableGroqProxyCheckbox.checked = enableAudioTranscriptionCheckbox.checked
      ? Boolean(settings.enableGroqProxy)
      : false;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const currentTab = tabs[0];
    if (!currentTab || !currentTab.id) return;
    if (!isBilibiliVideoPage(currentTab.url)) {
      resultDiv.textContent = '当前不在哔哩哔哩视频页面';
      return;
    }

    chrome.tabs.sendMessage(currentTab.id, { type: 'GET_AD_INFO' }, async (response) => {
      if (chrome.runtime.lastError) {
        resultDiv.textContent = '插件未完全加载，请等待或刷新';
        return;
      }
      if (response && response.adInfo) resultDiv.textContent = `${response.adInfo}`;
      else resultDiv.textContent = '未检测到广告信息';
    });
  });

  const enableWhitelistCheckbox = document.getElementById('enableWhitelist') as HTMLInputElement;
  const upUidInput = document.getElementById('upUid') as HTMLInputElement;
  const addToWhitelistButton = document.getElementById('addToWhitelist') as HTMLButtonElement;
  const whitelistList = document.querySelector('.whitelist-list') as HTMLDivElement;

  const whitelistConfig = await WhitelistService.getConfig();
  enableWhitelistCheckbox.checked = whitelistConfig.enabled;
  document.body.classList.toggle('whitelist-enabled', whitelistConfig.enabled);

  function renderWhitelistItems() {
    whitelistList.innerHTML = '';
    whitelistConfig.whitelistedUPs.forEach((up) => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'whitelist-item';

      const span = document.createElement('span');
      span.textContent = `${up.name} (UID: ${up.uid})`;

      const button = document.createElement('button');
      button.textContent = '移除';
      button.dataset.uid = up.uid;

      itemDiv.appendChild(span);
      itemDiv.appendChild(button);
      whitelistList.appendChild(itemDiv);
    });
  }
  renderWhitelistItems();

  enableWhitelistCheckbox.addEventListener('change', async () => {
    await WhitelistService.setEnabled(enableWhitelistCheckbox.checked);
    document.body.classList.toggle('whitelist-enabled', enableWhitelistCheckbox.checked);
  });

  addToWhitelistButton.addEventListener('click', async () => {
    const uid = upUidInput.value.trim();
    if (!uid) {
      showMessage('请输入UP主UID', 'error');
      return;
    }

    try {
      const upInfo = await BilibiliService.getUpInfo(uid);
      const added = await WhitelistService.addToWhitelist({
        uid,
        name: upInfo.name,
      });

      if (added) {
        showMessage('已添加到白名单', 'success');
        upUidInput.value = '';
        whitelistConfig.whitelistedUPs = (await WhitelistService.getConfig()).whitelistedUPs;
        renderWhitelistItems();
      } else {
        showMessage('该UP主已在白名单中', 'error');
      }
    } catch (error) {
      showMessage(normalizeErrorForUser(error, 'whitelist'), 'error');
    }
  });

  whitelistList.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'BUTTON') return;
    const uid = target.dataset.uid;
    if (!uid) return;
    await WhitelistService.removeFromWhitelist(uid);
    whitelistConfig.whitelistedUPs = (await WhitelistService.getConfig()).whitelistedUPs;
    renderWhitelistItems();
    showMessage('已从白名单移除', 'success');
  });
});
