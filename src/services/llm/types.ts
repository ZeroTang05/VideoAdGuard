export type LLMProvider = 'openai' | 'anthropic' | 'custom_fetch' | 'system_one';

/** 字幕索引保持原值，检测结果会用它查找字幕的起止时间。 */
export interface AdVideoInfo {
  title: string;
  topComment: string | null;
  additionalMessages: Record<string, Record<string, unknown>> | null;
  captions: Record<number, string>;
  goodNames?: string[];
}

/** AI 文案检测的输入：标题、简介和抽样后的文案文本。 */
export interface AIScriptInfo {
  title: string;
  description: string;
  sample: string;
}

/** Jev 使用明确的任务数据，避免从聊天提示词中反向解析字幕。 */
export type LLMTask =
  | { kind: 'detect_ad'; videoInfo: AdVideoInfo; restricted: boolean }
  | { kind: 'detect_ai_script'; scriptInfo: AIScriptInfo }
  | { kind: 'product_name'; linkTitle: string };

export type LLMResponseFormat = 'json' | 'text';

export interface LLMInvokePayload {
  systemPrompt: string;
  userPrompt: string;
  responseFormat: LLMResponseFormat;
  maxTokens: number;
  task?: LLMTask;
}

export interface LLMInvokeResult {
  text: string;
  provider: LLMProvider;
  model: string;
  requestId?: string;
}

export interface StoredLLMSettings {
  provider?: LLMProvider;
  baseUrl?: string;
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  enableLocalOllama?: boolean;
}

export interface ResolvedLLMSettings {
  provider: LLMProvider;
  apiUrl: string;
  apiKey: string | null;
  model: string;
  baseUrl: string;
}
