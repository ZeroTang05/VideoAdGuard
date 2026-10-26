import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createHttpError } from '../../utils/errors';
import { resolveLLMSettings } from './config';
import { invokeWithSystemOne } from './system-one';
import {
  LLMInvokePayload,
  LLMInvokeResult,
  ResolvedLLMSettings,
  StoredLLMSettings,
} from './types';

type OpenAICompatibleRequest = {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
};

export function buildOpenAICompatibleRequest(
  payload: LLMInvokePayload,
  model: string
): OpenAICompatibleRequest {
  return {
    model,
    messages: [
      { role: 'system', content: payload.systemPrompt },
      { role: 'user', content: payload.userPrompt },
    ],
  };
}

export class LLMGateway {
  public static async invoke(
    payload: LLMInvokePayload,
    storedSettings: StoredLLMSettings
  ): Promise<LLMInvokeResult> {
    const settings = resolveLLMSettings(storedSettings);
    if (!settings.baseUrl) {
      throw new Error('未设置基础地址，请先在 Base URL 下拉中选择或手动填写');
    }

    switch (settings.provider) {
      case 'system_one':
        return invokeWithSystemOne(payload, settings);
      case 'anthropic':
        return this.invokeWithAnthropic(payload, settings);
      case 'custom_fetch':
        return this.invokeWithCustomFetch(payload, settings);
      default:
        return this.invokeWithOpenAI(payload, settings);
    }
  }

  private static async invokeWithOpenAI(
    payload: LLMInvokePayload,
    settings: ResolvedLLMSettings
  ): Promise<LLMInvokeResult> {
    if (!settings.apiKey) {
      throw new Error('未设置API密钥');
    }

    const client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      dangerouslyAllowBrowser: true,
      maxRetries: 1,
      timeout: 30_000,
    });

    const request = buildOpenAICompatibleRequest(payload, settings.model);

    const completion = await client.chat.completions.create(request);
    const text = completion.choices[0]?.message?.content;

    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('大模型未返回文本内容');
    }

    return {
      text: text.trim(),
      provider: settings.provider,
      model: settings.model,
      requestId: completion._request_id ?? undefined,
    };
  }

  private static async invokeWithAnthropic(
    payload: LLMInvokePayload,
    settings: ResolvedLLMSettings
  ): Promise<LLMInvokeResult> {
    if (!settings.apiKey) {
      throw new Error('未设置API密钥');
    }

    const client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      dangerouslyAllowBrowser: true,
      maxRetries: 1,
      timeout: 30_000,
    });

    const message = await client.messages.create({
      model: settings.model,
      max_tokens: payload.maxTokens,
      system: payload.systemPrompt,
      messages: [
        {
          role: 'user',
          content: payload.userPrompt,
        },
      ],
    });

    const text = message.content
      .filter(
        (
          block
        ): block is Extract<(typeof message.content)[number], { type: 'text'; text: string }> =>
          block.type === 'text'
      )
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) {
      throw new Error('Anthropic 未返回文本内容');
    }

    return {
      text,
      provider: settings.provider,
      model: settings.model,
      requestId: message.id,
    };
  }

  private static async invokeWithCustomFetch(
    payload: LLMInvokePayload,
    settings: ResolvedLLMSettings
  ): Promise<LLMInvokeResult> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const isOpenAICompatible = settings.apiUrl.includes('/chat/completions');
    const response = await fetch(settings.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        isOpenAICompatible
          ? buildOpenAICompatibleRequest(payload, settings.model)
          : {
              model: settings.model,
              messages: [
                { role: 'system', content: payload.systemPrompt },
                { role: 'user', content: payload.userPrompt },
              ],
              stream: false,
            }
      ),
    });

    if (!response.ok) {
      throw await createHttpError(response, '自定义 fetch 请求失败');
    }

    const data = await response.json();
    const text = data?.message?.content || data?.choices?.[0]?.message?.content || data?.output_text;

    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('自定义 fetch 未返回文本内容');
    }

    return {
      text: text.trim(),
      provider: settings.provider,
      model: settings.model,
    };
  }
}
