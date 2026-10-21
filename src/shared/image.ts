export const SUPPORTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** 长边上限：既保证截图里的正文可读，又把请求体控制在常见视觉模型的限制内。 */
export const MAX_IMAGE_EDGE = 1600;
export const MAX_IMAGE_DATA_URL_LENGTH = 8 * 1024 * 1024;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

export function isSupportedImageType(type: string): type is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type);
}

/** 按长边等比缩放；尺寸非法时抛出可展示的错误。 */
export function fitWithin(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error("图片尺寸无效。");
  }
  if (!Number.isFinite(maxEdge) || maxEdge < 1) throw new Error("图片尺寸上限无效。");
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

export function isImageDataUrl(value: string): boolean {
  return value.length <= MAX_IMAGE_DATA_URL_LENGTH && IMAGE_DATA_URL.test(value);
}

/** 把设置里的语言代码转成提示词里的可读名称。 */
export function languageName(code: string): string {
  const names: Record<string, string> = {
    en: "English",
    "zh-CN": "Simplified Chinese",
    "zh-TW": "Traditional Chinese",
    ja: "Japanese",
    ko: "Korean",
    fr: "French",
    de: "German",
    es: "Spanish",
    auto: "the detected source language"
  };
  return names[code] ?? code;
}
