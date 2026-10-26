/** System One 服务商预设：界面默认模型与调用所需请求头使用同一份配置。 */
export interface SystemOnePreset {
  name: string;
  baseUrl: string;
  defaultModel: string;
  actionLabel: string;
  actionUrl: string;
  headers?: Record<string, string>;
}

export const SYSTEM_ONE_PRESETS: SystemOnePreset[] = [
  { name: 'TypeSafe', baseUrl: 'https://api.typesafe.ai/v1', defaultModel: 'jev-latest', actionLabel: '获取密钥', actionUrl: 'https://console.typesafe.ai/settings/keys' },
  { name: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/typesafe/v1', defaultModel: 'typesafe-ai/jev', actionLabel: '控制台', actionUrl: 'https://vercel.com/ai-gateway' },
  { name: 'OpenCode Zen', baseUrl: 'https://opencode.ai/inference/systemone/v1', defaultModel: 'jev-1.13', actionLabel: '控制台', actionUrl: 'https://opencode.ai/auth' },
  { name: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v1', defaultModel: 'doubao-seed-2-1-lite-260915', actionLabel: '控制台', actionUrl: 'https://console.volcengine.com/ark', headers: { 'ark-beta-systemone-api': 'true' } },
  { name: 'Modelink（中国大陆）', baseUrl: 'https://api.qnaigc.com/v1', defaultModel: 'jev-latest', actionLabel: '文档', actionUrl: 'https://docs.modelink.ai/models-capabilities/model-jev' },
  { name: 'Modelink（海外）', baseUrl: 'https://api.modelink.ai/v1', defaultModel: 'jev-latest', actionLabel: '文档', actionUrl: 'https://docs.modelink.ai/models-capabilities/model-jev' },
  { name: 'Right Code', baseUrl: 'https://www.rightapi.ai/v1', defaultModel: 'jev-latest', actionLabel: '文档', actionUrl: 'https://docs.right.codes/docs/rc_jev/' },
];

/** SDK 会追加 /v1/systemone，保留网关原有的路径前缀。 */
export function getSystemOneSdkBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/systemone$/, '').replace(/\/v1$/, '');
}

/** 按标准化地址识别预设，完整端点与基础地址共用服务商配置。 */
export function findSystemOnePreset(baseUrl: string): SystemOnePreset | undefined {
  const sdkBaseUrl = getSystemOneSdkBaseUrl(baseUrl);
  return SYSTEM_ONE_PRESETS.find((preset) => getSystemOneSdkBaseUrl(preset.baseUrl) === sdkBaseUrl);
}
