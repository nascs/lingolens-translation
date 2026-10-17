export type LanguageCategory = "chinese" | "other" | "unknown";

export interface DetectedLanguage {
  language: string;
  percentage: number;
}

export interface LanguageDetectionResult {
  isReliable: boolean;
  languages: DetectedLanguage[];
}

export type LanguageDetector = (text: string) => Promise<LanguageDetectionResult>;

export interface TargetLanguageDecision {
  detectedLanguage?: string;
  category: LanguageCategory;
  resolvedTargetLanguage: string;
  label: string;
}

const HAN = /\p{Script=Han}/u;
const KANA = /\p{Script=Hiragana}|\p{Script=Katakana}/u;
const HANGUL = /\p{Script=Hangul}/u;
const CHINESE_LANGUAGES = new Set(["zh", "cmn", "yue", "wuu", "gan", "hak", "nan"]);
const LANGUAGE_LABELS: Record<string, string> = {
  en: "英语",
  "zh-CN": "简体中文",
  "zh-TW": "繁体中文",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  es: "西班牙语"
};

function primaryLanguage(language: string): string {
  return language.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

function isChineseLanguage(language: string): boolean {
  return CHINESE_LANGUAGES.has(primaryLanguage(language));
}

function decision(detectedLanguage: string | undefined, category: LanguageCategory): TargetLanguageDecision {
  const resolvedTargetLanguage = category === "chinese" ? "en" : "zh-CN";
  const detectedLabel = category === "chinese" ? "中文" : category === "other" ? "非中文" : "未知语言";
  return {
    detectedLanguage,
    category,
    resolvedTargetLanguage,
    label: `检测到${detectedLabel}，翻译为${LANGUAGE_LABELS[resolvedTargetLanguage]}`
  };
}

function fallbackDecision(text: string): TargetLanguageDecision {
  if (!text.trim()) return decision(undefined, "unknown");
  if (KANA.test(text)) return decision("ja", "other");
  if (HANGUL.test(text)) return decision("ko", "other");
  if (HAN.test(text)) return decision("zh", "chinese");
  return decision(undefined, "other");
}

const defaultDetector: LanguageDetector = (text) => chrome.i18n.detectLanguage(text);

export async function resolveTargetLanguage(
  text: string,
  targetLanguage: string,
  detector: LanguageDetector = defaultDetector
): Promise<TargetLanguageDecision> {
  if (targetLanguage !== "smart") {
    return {
      category: "unknown",
      resolvedTargetLanguage: targetLanguage,
      label: `目标语言：${LANGUAGE_LABELS[targetLanguage] ?? targetLanguage}`
    };
  }

  try {
    const result = await detector(text);
    const main = result.languages
      .filter(({ language }) => primaryLanguage(language) !== "und")
      .sort((left, right) => right.percentage - left.percentage)[0];
    if (main) {
      const detectedLanguage = main.language.trim();
      return decision(detectedLanguage, isChineseLanguage(detectedLanguage) ? "chinese" : "other");
    }
  } catch {
    // Detection is best-effort; script inspection below is deterministic and private.
  }
  return fallbackDecision(text);
}
