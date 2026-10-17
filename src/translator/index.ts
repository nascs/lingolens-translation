import "./styles.css";
import { loadSettings } from "../shared/config";
import { resolveTargetLanguage, type TargetLanguageDecision } from "../shared/language";
import type { Response, TranslationResult } from "../shared/messages";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const source = element<HTMLTextAreaElement>("source-text");
const result = element("result-text");
const sourceLanguage = element<HTMLSelectElement>("source-language");
const targetLanguage = element<HTMLSelectElement>("target-language");
const translateButton = element<HTMLButtonElement>("translate-button");
const copyButton = element<HTMLButtonElement>("copy-button");
const count = element("character-count");
const notice = element("notice");
const providerStatus = element("provider-status");
let translatedText = "";
let lastTranslation: { sourceLanguage: string; targetLanguage: string } | undefined;

function updateCount(): void {
  count.textContent = `${source.value.length.toLocaleString()} / 12,000`;
}

function hasOption(select: HTMLSelectElement, value: string): boolean {
  return Array.from(select.options).some((option) => option.value === value);
}

function detectedSource(decision: TargetLanguageDecision): string {
  const detected = decision.detectedLanguage?.toLowerCase().replace("_", "-");
  const primary = detected?.split("-", 1)[0];
  if (detected === "zh-tw" || detected === "zh-hant") return "zh-TW";
  if (primary === "zh" || primary === "cmn" || decision.category === "chinese") return "zh-CN";
  if (primary && hasOption(sourceLanguage, primary)) return primary;
  return decision.resolvedTargetLanguage === "zh-CN" ? "en" : "zh-CN";
}

async function translate(): Promise<void> {
  const text = source.value.trim();
  if (!text) { notice.textContent = "请先输入要翻译的内容。"; source.focus(); return; }
  translateButton.disabled = true;
  notice.textContent = "";
  result.textContent = "AI 正在理解语境并翻译…";
  try {
    const decision = await resolveTargetLanguage(text, targetLanguage.value);
    if (targetLanguage.value === "smart") notice.textContent = decision.label;
    const actualSource = sourceLanguage.value === "auto" ? detectedSource(decision) : sourceLanguage.value;
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_BATCH",
      items: [{ id: "standalone", text }],
      sourceLanguage: sourceLanguage.value,
      targetLanguage: decision.resolvedTargetLanguage
    }) as Response<TranslationResult[]>;
    if (!response.ok) throw new Error(response.error);
    translatedText = response.data[0]?.text ?? "";
    result.textContent = translatedText || "没有收到译文。";
    copyButton.disabled = !translatedText;
    if (translatedText) lastTranslation = { sourceLanguage: actualSource, targetLanguage: decision.resolvedTargetLanguage };
  } catch (error) {
    translatedText = "";
    lastTranslation = undefined;
    copyButton.disabled = true;
    result.innerHTML = "<span>译文会出现在这里。</span>";
    notice.textContent = error instanceof Error ? error.message : "翻译失败";
  } finally {
    translateButton.disabled = false;
  }
}

source.addEventListener("input", updateCount);
source.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key === "Enter") { event.preventDefault(); void translate(); }
});
translateButton.addEventListener("click", () => void translate());

element<HTMLButtonElement>("clear-button").addEventListener("click", () => {
  source.value = "";
  translatedText = "";
  lastTranslation = undefined;
  result.innerHTML = "<span>译文会出现在这里。</span>";
  copyButton.disabled = true;
  notice.textContent = "";
  updateCount();
  source.focus();
});

element<HTMLButtonElement>("swap-button").addEventListener("click", () => {
  if (translatedText && lastTranslation) {
    const previousLanguages = lastTranslation;
    const previous = source.value;
    source.value = translatedText;
    translatedText = previous;
    result.textContent = previous;
    sourceLanguage.value = hasOption(sourceLanguage, previousLanguages.targetLanguage) ? previousLanguages.targetLanguage : "auto";
    targetLanguage.value = hasOption(targetLanguage, previousLanguages.sourceLanguage)
      ? previousLanguages.sourceLanguage
      : previousLanguages.targetLanguage === "zh-CN" ? "en" : "zh-CN";
    lastTranslation = { sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value };
    copyButton.disabled = !previous;
    updateCount();
    return;
  }

  const previousSource = sourceLanguage.value;
  const concreteTarget = targetLanguage.value === "smart" ? "zh-CN" : targetLanguage.value;
  sourceLanguage.value = hasOption(sourceLanguage, concreteTarget) ? concreteTarget : "auto";
  const fallbackTarget = previousSource !== "auto" && hasOption(targetLanguage, previousSource)
    ? previousSource
    : concreteTarget === "zh-CN" ? "en" : "zh-CN";
  targetLanguage.value = fallbackTarget;
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(translatedText);
  copyButton.textContent = "已复制";
  window.setTimeout(() => { copyButton.textContent = "复制译文"; }, 1200);
});
element<HTMLButtonElement>("settings-button").addEventListener("click", () => void chrome.runtime.openOptionsPage());

void loadSettings().then((settings) => {
  if (hasOption(sourceLanguage, settings.sourceLanguage)) sourceLanguage.value = settings.sourceLanguage;
  targetLanguage.value = "smart";
  providerStatus.textContent = settings.apiKey ? `${settings.provider === "custom" ? "兼容服务" : settings.provider} · ${settings.model}` : "尚未配置 API Key";
  if (!settings.apiKey) notice.textContent = "请先打开 AI 设置并填写 API Key。";
}).catch(() => { providerStatus.textContent = "无法读取 AI 配置"; });
