export type Provider = "openai" | "deepseek" | "custom";
export type TranslationStyle = "subtle" | "card" | "underline";
export type DisplayMode = "bilingual" | "translation" | "hover";

export interface Settings {
  provider: Provider;
  apiKey: string;
  baseUrl: string;
  model: string;
  allowInsecureHttp: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  translationStyle: TranslationStyle;
  translateDynamicContent: boolean;
  showSelectionButton: boolean;
  displayMode: DisplayMode;
  glossary: string;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "custom",
  apiKey: "",
  baseUrl: "",
  model: "",
  allowInsecureHttp: false,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  translationStyle: "subtle",
  translateDynamicContent: true,
  showSelectionButton: true,
  displayMode: "bilingual",
  glossary: ""
};

const PROVIDER_DEFAULTS: Record<Provider, Pick<Settings, "baseUrl" | "model">> = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  custom: { baseUrl: "", model: "" }
};

export function defaultsForProvider(provider: Provider): Pick<Settings, "baseUrl" | "model"> {
  return PROVIDER_DEFAULTS[provider];
}

export interface GlossaryEntry {
  from: string;
  to: string;
}

export const MAX_GLOSSARY_ENTRIES = 100;
export const MAX_GLOSSARY_TERM_LENGTH = 60;
export const MAX_GLOSSARY_RAW_LENGTH = 8000;

export function normalizeDisplayMode(value: unknown): DisplayMode {
  return value === "translation" || value === "hover" ? value : "bilingual";
}

/** 解析「原文=译文」行；空行与 # 注释忽略，超长/缺项跳过，最多 MAX_GLOSSARY_ENTRIES 条。 */
export function parseGlossary(raw: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const from = trimmed.slice(0, separator).trim();
    const to = trimmed.slice(separator + 1).trim();
    if (!from || !to) continue;
    if (from.length > MAX_GLOSSARY_TERM_LENGTH || to.length > MAX_GLOSSARY_TERM_LENGTH) continue;
    entries.push({ from, to });
    if (entries.length >= MAX_GLOSSARY_ENTRIES) break;
  }
  return entries;
}

export interface TransportInfo {
  normalizedUrl: string;
  origin: string;
  permissionPattern: string;
  requiresInsecureHttpConsent: boolean;
}

export function validateTransport(baseUrl: string, allowInsecureHttp = false): TransportInfo {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("API 地址无效。");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("API 地址必须是无凭据的 HTTP 或 HTTPS 地址。");
  }
  const hostname = url.hostname.toLowerCase();
  const localHttp = url.protocol === "http:"
    && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1");
  const requiresInsecureHttpConsent = url.protocol === "http:" && !localHttp;
  if (requiresInsecureHttpConsent && !allowInsecureHttp) {
    throw new Error("远程 HTTP 会明文传输 API Key 和翻译文本，必须先明确同意风险。");
  }
  return {
    normalizedUrl: url.href.replace(/\/+$/, ""),
    origin: url.origin,
    permissionPattern: `${url.origin}/*`,
    requiresInsecureHttpConsent
  };
}

const SETTING_KEYS = [
  "provider",
  "apiKey",
  "baseUrl",
  "model",
  "allowInsecureHttp",
  "sourceLanguage",
  "targetLanguage",
  "translationStyle",
  "translateDynamicContent",
  "showSelectionButton",
  "displayMode",
  "glossary"
] as const;

export async function loadSettings(): Promise<Settings> {
  // 只读取设置键，避免把体积较大的翻译缓存一并读出。
  const stored: unknown = await chrome.storage.local.get([...SETTING_KEYS]);
  return normalizeSettings(stored);
}

export async function saveSettings(settings: Settings): Promise<void> {
  const normalized = normalizeSettings(settings);
  normalized.baseUrl = validateTransport(normalized.baseUrl, normalized.allowInsecureHttp).normalizedUrl;
  await chrome.storage.local.set(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeSettings(input: unknown): Settings {
  const value = isRecord(input) ? input : {};
  const provider = value.provider === "openai" || value.provider === "deepseek" || value.provider === "custom"
    ? value.provider
    : DEFAULT_SETTINGS.provider;
  const defaults = defaultsForProvider(provider);
  return {
    provider,
    apiKey: typeof value.apiKey === "string" ? value.apiKey.trim() : "",
    baseUrl: typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim().replace(/\/+$/, "") : defaults.baseUrl,
    model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : defaults.model,
    allowInsecureHttp: value.allowInsecureHttp === true,
    sourceLanguage: typeof value.sourceLanguage === "string" ? value.sourceLanguage : DEFAULT_SETTINGS.sourceLanguage,
    targetLanguage: typeof value.targetLanguage === "string" ? value.targetLanguage : DEFAULT_SETTINGS.targetLanguage,
    translationStyle: value.translationStyle === "card" || value.translationStyle === "underline" ? value.translationStyle : "subtle",
    translateDynamicContent: typeof value.translateDynamicContent === "boolean" ? value.translateDynamicContent : true,
    showSelectionButton: typeof value.showSelectionButton === "boolean" ? value.showSelectionButton : true,
    displayMode: normalizeDisplayMode(value.displayMode),
    glossary: typeof value.glossary === "string" ? value.glossary.slice(0, MAX_GLOSSARY_RAW_LENGTH) : ""
  };
}

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

export function permissionPatternForBaseUrl(baseUrl: string, allowInsecureHttp = false): string {
  return validateTransport(baseUrl, allowInsecureHttp).permissionPattern;
}
