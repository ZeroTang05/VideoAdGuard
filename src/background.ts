/**
 * Background Script - 后台脚本
 * 负责处理跨域请求和语音识别API调用
 */

import './utils/logger';
import { STORAGE_KEYS } from './services/llm/config';
import { LLMGateway } from './services/llm/providers';
import { LLMInvokePayload, StoredLLMSettings } from './services/llm/types';
import { createHttpError, normalizeErrorForUser } from './utils/errors';

export {}

// 消息类型枚举
enum MessageType {
  TRANSCRIBE_AUDIO_FILE_STREAM = 'TRANSCRIBE_AUDIO_FILE_STREAM',
  LLM_INVOKE = 'LLM_INVOKE',
  API_REQUEST = 'API_REQUEST',
  CLOUD_CACHE_REQUEST = 'CLOUD_CACHE_REQUEST',
}

// 通用消息结构
interface BaseMessage {
  type: string;
}

// API 请求消息
interface ApiRequestMessage extends BaseMessage {
  type: MessageType.API_REQUEST;
  data: {
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  };
}

// LLM 调用消息
interface LLMInvokeMessage extends BaseMessage {
  type: MessageType.LLM_INVOKE;
  payload: {
    systemPrompt: string;
    userPrompt: string;
    responseFormat?: 'text' | 'json';
    maxTokens?: number;
    temperature?: number;
    task?: LLMInvokePayload['task'];
  };
}

// 音频转录消息
interface AudioTranscriptionMessage extends BaseMessage {
  type: MessageType.TRANSCRIBE_AUDIO_FILE_STREAM;
  data: {
    audioUrl?: string;
    audioBytes?: ArrayBuffer;
    audioBlobUrl?: string;
    fileInfo?: { name?: string; type?: string; size?: number };
    apiKey: string;
    options?: {
      model?: string;
      responseFormat?: string;
      language?: string;
      temperature?: number;
      allowProxyFallback?: boolean;
    };
  };
}

// 云端缓存请求消息
interface CloudCacheRequestMessage extends BaseMessage {
  type: MessageType.CLOUD_CACHE_REQUEST;
  payload: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: Record<string, unknown>;
    writeOrderKey?: string;
  };
}

// 响应接口
interface ApiResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// 音频转录选项
interface TranscriptionOptions {
  model?: string;
  responseFormat?: string;
  language?: string;
  temperature?: number;
}

// 消息处理器类
class MessageHandler {
  /**
   * 处理来自content script的消息
   */
  static handleMessage(message: BaseMessage | ApiRequestMessage | LLMInvokeMessage | AudioTranscriptionMessage | CloudCacheRequestMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response: ApiResponse) => void): boolean {
    try {
      // 处理语音识别请求
      if (message.type === MessageType.TRANSCRIBE_AUDIO_FILE_STREAM) {
        AudioTranscriptionHandler.handle((message as AudioTranscriptionMessage).data, sendResponse);
        return true; // 异步响应
      }

      // 处理模型调用请求
      if (message.type === MessageType.LLM_INVOKE) {
        LLMInvokeHandler.handle(message as LLMInvokeMessage, sendResponse);
        return true; // 异步响应
      }

      // 处理通用API请求
      if (MessageHandler.isApiRequest(message)) {
        ApiRequestHandler.handle(message as ApiRequestMessage, sendResponse);
        return true; // 异步响应
      }

      // 处理云端缓存请求
      if (message.type === MessageType.CLOUD_CACHE_REQUEST) {
        CloudCacheRequestHandler.handle((message as CloudCacheRequestMessage).payload, sendResponse);
        return true; // 异步响应
      }

      // 无效消息结构
      sendResponse({ success: false, error: "Invalid message structure" });
      return false;
    } catch (error) {
      console.warn('【VideoAdGuard】[Background] 消息处理失败:', error);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error)
      });
      return false;
    }
  }

  /**
   * 检查是否为API请求
   */
  private static isApiRequest(message: unknown): boolean {
    const msg = message as BaseMessage;
    if (msg?.type === MessageType.API_REQUEST) {
      const data = (msg as ApiRequestMessage).data;
      return Boolean(data?.url && data?.headers && data?.body);
    }
    const data = msg as { url?: unknown; headers?: unknown; body?: unknown };
    return Boolean(data?.url && data?.headers && data?.body);
  }
}

// 通用API请求处理器
class ApiRequestHandler {
  /**
   * 处理通用API请求
   */
  static async handle(message: ApiRequestMessage, sendResponse: (response: ApiResponse) => void): Promise<void> {
    try {
      const payload = message.data;
      const { url, headers, body } = payload;

      if (!url) {
        throw new Error('请求地址为空');
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw await createHttpError(response, '请求失败');
      }

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();
      sendResponse({ success: true, data });
    } catch (error) {
      console.warn('【VideoAdGuard】[Background] API请求失败:', error);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error, 'network')
      });
    }
  }
}

class LLMInvokeHandler {
  static async handle(message: LLMInvokeMessage, sendResponse: (response: ApiResponse) => void): Promise<void> {
    try {
      const payload = message.payload;

      if (!payload || typeof payload.systemPrompt !== 'string' || typeof payload.userPrompt !== 'string') {
        throw new Error('模型请求参数无效');
      }

      const storedSettings = (await chrome.storage.local.get(
        [...STORAGE_KEYS]
      )) as StoredLLMSettings;

      const result = await LLMGateway.invoke(
        {
          systemPrompt: payload.systemPrompt,
          userPrompt: payload.userPrompt,
          responseFormat: payload.responseFormat === 'text' ? 'text' : 'json',
          maxTokens: typeof payload.maxTokens === 'number' ? payload.maxTokens : 1024,
          task: payload.task,
        },
        storedSettings
      );

      sendResponse({ success: true, data: result });
    } catch (error) {
      console.warn('【VideoAdGuard】[Background] 模型请求失败:', error);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error, 'llm')
      });
    }
  }
}

// 音频转录处理器
class AudioTranscriptionHandler {
  private static readonly GROQ_OFFICIAL_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
  private static readonly GROQ_PROXY_URL = 'https://ai-proxy.xiaobaozi.cn/api.groq.com/openai/v1/audio/transcriptions';
  private static readonly DEFAULT_MODEL = 'whisper-large-v3-turbo';
  private static readonly DEFAULT_RESPONSE_FORMAT = 'verbose_json';

  /**
   * 处理音频转录请求
   * 支持传入：
   *  - audioBytes(ArrayBuffer)
   *  - audioBlobUrl(推荐在 Edge/Chrome：data:URL 或可直连的 http(s) URL)
   *  - audioUrl(兜底，后台自行下载)
   */
  static async handle(data: AudioTranscriptionMessage['data'], sendResponse: (response: ApiResponse) => void): Promise<void> {
    try {
      console.log('【VideoAdGuard】[Background] 开始语音识别...');

      const { audioUrl, audioBytes, audioBlobUrl, fileInfo, apiKey, options } = data;
      const allowProxyFallback = Boolean(options?.allowProxyFallback);

      // 验证API密钥
      if (!apiKey) {
        throw new Error('未配置Groq API密钥，请在设置中配置');
      }

      // 如果仅提供了 URL（无 bytes / 无 blobUrl），直接走流式上传，避免二次缓冲
      if (audioUrl && !(audioBytes instanceof ArrayBuffer) && !audioBlobUrl) {
        const result = await this.callGroqApiWithStream(audioUrl, fileInfo || {}, options || {}, apiKey, allowProxyFallback);
        console.log('【VideoAdGuard】[Background] 语音识别成功(流)');
        sendResponse({ success: true, data: result });
        return;
      }

      // 统一构建 Blob：使用 audioBytes / audioBlobUrl
      const builtBlob = await this.buildAudioBlob(data);

      const sizeMB = (builtBlob.size / 1024 / 1024).toFixed(2);
      console.log(`【VideoAdGuard】[Background] 准备上传音频，大小: ${sizeMB}MB`);

      // 使用Blob调用Groq API
  const result = await this.callGroqApiWithBlob(builtBlob, fileInfo || {}, options || {}, apiKey, allowProxyFallback);

      console.log('【VideoAdGuard】[Background] 语音识别成功');
      sendResponse({ success: true, data: result });
    } catch (error) {
      console.warn('【VideoAdGuard】[Background] 语音识别失败:', error);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error, 'audio')
      });
    }
  }

  // 从多种输入构建Blob（支持 audioBytes / audioBlobUrl(blob:)）
  private static async buildAudioBlob(input: AudioTranscriptionMessage['data']): Promise<Blob> {
    const { audioBytes, audioBlobUrl, fileInfo } = input;

    let audioBlob: Blob | undefined;

    // 1) blob:（来自 content 端的 Blob 转 URL）
    if (typeof audioBlobUrl === 'string' && audioBlobUrl.startsWith('blob:')) {
        const audioResponse = await fetch(audioBlobUrl);
        const audioStream = audioResponse.body;

        // 将流包装成Response，然后转换为Blob，但使用更小的块
        const fileType = fileInfo?.type || 'audio/m4a';
        const fileSize = fileInfo?.size;
        const headers: Record<string, string> = { 'Content-Type': fileType };
        if (fileSize !== undefined) {
          headers['Content-Length'] = fileSize.toString();
        }
        const streamResponse = new Response(audioStream, { headers });
        audioBlob = await streamResponse.blob();
    } else if (audioBytes instanceof ArrayBuffer) {
      const type = fileInfo?.type || 'audio/m4a';
      audioBlob = new Blob([new Uint8Array(audioBytes)], { type });
    }

    if (!audioBlob) {
      throw new Error('未提供有效的音频数据');
    }

    // Groq 限制：建议小于 19MB
    const maxSize = 19 * 1024 * 1024;
    if (audioBlob.size > maxSize) {
      const fileSizeMB = (audioBlob.size / 1024 / 1024).toFixed(2);
      throw new Error(`音频文件过大 (${fileSizeMB}MB)，超过Groq API限制(19MB)。`);
    }

    return audioBlob;
  }

  /**
   * 使用Blob调用Groq API
   */
  private static async callGroqApiWithBlob(
    audioBlob: Blob,
    fileInfo: { name?: string; type?: string },
    options: TranscriptionOptions,
    apiKey: string,
    allowProxyFallback: boolean
  ): Promise<unknown> {
    const file = new File([audioBlob], fileInfo?.name || 'audio.m4a', {
      type: fileInfo?.type || 'audio/m4a',
      lastModified: Date.now()
    });

    return this.uploadWithFallback(() => this.buildTranscriptionFormData(file, options), apiKey, allowProxyFallback);
  }

  /**
   * 使用 URL 以流方式获取音频并直接构造表单上传 Groq
   */
  private static async callGroqApiWithStream(
    audioUrl: string,
    fileInfo: { name?: string; type?: string; size?: number },
    options: TranscriptionOptions,
    apiKey: string,
    allowProxyFallback: boolean
  ): Promise<unknown> {
    // 获取音频流
    const audioResponse = await fetch(audioUrl);
    if (!audioResponse.ok) {
      throw new Error('无法获取音频数据');
    }

    const audioStream = audioResponse.body as ReadableStream<Uint8Array> | null;
    if (!audioStream) {
      throw new Error('无法获取文件流');
    }

    // 推断类型与长度
    let type = (fileInfo?.type || audioResponse.headers.get('content-type') || 'audio/m4a') as string;
    const lenFromHeader = audioResponse.headers.get('content-length') || undefined;
    const name = (fileInfo?.name || 'audio.m4a') as string;

    // 将流包装成 Response，再转为 Blob
    const headers: Record<string, string> = { 'Content-Type': type };
    if (fileInfo?.size) headers['Content-Length'] = String(fileInfo.size);
    else if (lenFromHeader) headers['Content-Length'] = lenFromHeader;

    const streamResponse = new Response(audioStream, { headers });
    const audioBlob = await streamResponse.blob();

    // Groq 限制：建议小于 19MB
    const maxSize = 19 * 1024 * 1024; // 19MB限制
    const fileSizeMB = audioBlob.size / 1024 / 1024;
    console.log(`【VideoAdGuard】[Background] 音频文件大小: ${fileSizeMB.toFixed(2)}MB`);
    if (audioBlob.size > maxSize) {
      throw new Error(`音频文件过大 (${fileSizeMB.toFixed(2)}MB)，超过Groq API限制(19MB)。`);
    }

    const file = new File([audioBlob], name, {
      type,
      lastModified: Date.now()
    });

    return this.uploadWithFallback(() => this.buildTranscriptionFormData(file, options), apiKey, allowProxyFallback);
  }

  private static buildTranscriptionFormData(file: File, options: TranscriptionOptions): FormData {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', options?.model || this.DEFAULT_MODEL);
    formData.append('response_format', options?.responseFormat || this.DEFAULT_RESPONSE_FORMAT);

    if (options?.language) {
      formData.append('language', options.language);
    }
    if (options?.temperature !== undefined) {
      formData.append('temperature', String(options.temperature));
    }

    return formData;
  }

  private static async uploadWithFallback(
    formDataFactory: () => FormData,
    apiKey: string,
    allowProxyFallback: boolean
  ): Promise<unknown> {
    const endpoints: Array<{ url: string; label: string }> = [
      { url: this.GROQ_OFFICIAL_URL, label: '官方' }
    ];

    if (allowProxyFallback) {
      endpoints.push({ url: this.GROQ_PROXY_URL, label: '代理' });
    }

    let lastError: Error | null = null;

    for (let index = 0; index < endpoints.length; index++) {
      const { url, label } = endpoints[index];
      const isLastAttempt = index === endpoints.length - 1;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: formDataFactory()
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`${response.status} ${response.statusText} - ${errorText}`);
        }

        if (label === '代理') {
          console.log('【VideoAdGuard】[Background] Groq代理接口调用成功');
        }

        return await response.json();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err;

        console.warn(`【VideoAdGuard】[Background] Groq${label}接口调用失败:`, err.message);

        if (!isLastAttempt) {
          console.warn('【VideoAdGuard】[Background] 准备使用Groq代理接口作为回退...');
          continue;
        }

        throw new Error(`Groq API调用失败: ${err.message}`);
      }
    }

    throw new Error(`Groq API调用失败${lastError ? `: ${lastError.message}` : ''}`);
  }
}

// 云端缓存请求处理器
class CloudCacheRequestHandler {
  private static readonly REQUEST_TIMEOUT_MS = 3000;
  private static readonly pendingWrites = new Map<string, Promise<void>>();

  static async handle(payload: CloudCacheRequestMessage['payload'], sendResponse: (response: ApiResponse) => void): Promise<void> {
    if (!payload.writeOrderKey) return this.request(payload, sendResponse);

    // 同一后端同一分 P 按点击顺序写入，其他分 P 和后端继续并行。
    const key = `${payload.url}|${payload.writeOrderKey}`;
    const previous = this.pendingWrites.get(key);
    const send = () => this.request(payload, sendResponse);
    const pending = previous ? previous.then(send, send) : send();
    this.pendingWrites.set(key, pending);
    try {
      await pending;
    } finally {
      if (this.pendingWrites.get(key) === pending) this.pendingWrites.delete(key);
    }
  }

  private static async request(payload: CloudCacheRequestMessage['payload'], sendResponse: (response: ApiResponse) => void): Promise<void> {
    try {
      const { url, method, headers, body } = payload;

      if (!url || typeof url !== 'string') {
        throw new Error('Worker URL 为空');
      }

      console.log(`【VideoAdGuard】[Background] 云端缓存请求: ${method} ${url}`);

      const fetchOptions: RequestInit = {
        method: method || 'GET',
        headers: headers || { 'Content-Type': 'application/json' },
      };

      if (body && method === 'POST') {
        fetchOptions.body = JSON.stringify(body);
      }

      // 使用 AbortController 实现可取消的超时
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CloudCacheRequestHandler.REQUEST_TIMEOUT_MS);
      fetchOptions.signal = controller.signal;

      let response: Response;
      try {
        response = await fetch(url, fetchOptions);
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('请求超时');
        }
        throw error;
      }
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '未知错误');
        throw new Error(`${response.status} ${response.statusText} - ${errorText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : await response.text();

      console.log(`【VideoAdGuard】[Background] 云端缓存响应成功: ${url}`);
      sendResponse({ success: true, data });
    } catch (error) {
      console.warn(`【VideoAdGuard】[Background] 云端缓存请求失败: ${error}`);
      sendResponse({
        success: false,
        error: normalizeErrorForUser(error, 'network'),
      });
    }
  }
}

// 注册消息监听器
chrome.runtime.onMessage.addListener(MessageHandler.handleMessage);
