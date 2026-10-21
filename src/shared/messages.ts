import type { Settings, TranslationStyle } from "./config";

export interface TranslationItem {
  id: string;
  text: string;
}

export interface TranslationResult extends TranslationItem {}

export interface ImageTranslationResult {
  sourceText: string;
  translatedText: string;
  model: string;
}

export type QuickWindowView = "text" | "image";

export type PageStatusName = "idle" | "translating" | "paused" | "completed" | "error";

export interface PageStatus {
  state: PageStatusName;
  total: number;
  completed: number;
  error?: string;
}

export interface PdfSourceRecord {
  sourceUrl: string;
  storedAt: number;
}

export interface PdfSourceResponse {
  source: PdfSourceRecord | null;
}

export type BackgroundRequest =
  | { type: "INJECT_ACTIVE_TAB" }
  | { type: "OPEN_TRANSLATOR" }
  | { type: "OPEN_QUICK_WINDOW"; view?: QuickWindowView }
  | { type: "OPEN_OPTIONS" }
  | { type: "OPEN_PDF_VIEWER"; tabId: number; sourceUrl?: string }
  | { type: "SET_PDF_SOURCE"; sourceUrl: string }
  | { type: "GET_PDF_SOURCE" }
  | { type: "CLEAR_PDF_SOURCE" }
  | { type: "CANCEL_PDF_TRANSLATIONS" }
  | { type: "TRANSLATE_BATCH"; items: TranslationItem[]; sourceLanguage: string; targetLanguage: string }
  | { type: "TRANSLATE_IMAGE"; imageDataUrl: string; sourceLanguage: string; targetLanguage: string }
  | { type: "TEST_PROVIDER"; settings: Settings };

export type PageRequest =
  | { type: "PAGE_START"; style: TranslationStyle }
  | { type: "PAGE_TOGGLE_PAUSE" }
  | { type: "PAGE_RESTORE" }
  | { type: "PAGE_GET_STATUS" }
  | { type: "PAGE_TRANSLATE_SELECTION"; text: string }
  | { type: "PAGE_EXPORT_TRANSLATIONS" };

export interface SuccessResponse<T> {
  ok: true;
  data: T;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

export type Response<T> = SuccessResponse<T> | ErrorResponse;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生了未知错误";
}
