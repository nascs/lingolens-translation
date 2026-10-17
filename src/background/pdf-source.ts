import type { PdfSourceRecord } from "../shared/messages";
import { extractPdfSourceFromTabUrl, parsePdfSourceUrl } from "../pdf/source";

export const PDF_SOURCE_TTL_MS = 10 * 60 * 1000;

export function pdfSourceStorageKey(tabId: number): string {
  return `pdf-source:${tabId}`;
}

export function isExactSenderPage(senderUrl: string | undefined, expectedUrl: string): boolean {
  return senderUrl === expectedUrl;
}

export function isValidPdfTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function pdfSourceMatchesTab(sourceUrl: string | undefined, tabUrl: string | undefined): boolean {
  if (sourceUrl === undefined) return true;
  try {
    const requested = parsePdfSourceUrl(sourceUrl);
    const current = extractPdfSourceFromTabUrl(tabUrl);
    return current?.href === requested.href;
  } catch {
    return false;
  }
}

export function createPdfSourceRecord(sourceUrl: string, now = Date.now()): PdfSourceRecord {
  return { sourceUrl, storedAt: now };
}

export function isFreshPdfSourceRecord(value: unknown, now = Date.now()): value is PdfSourceRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<PdfSourceRecord>;
  return typeof record.sourceUrl === "string"
    && record.sourceUrl.length > 0
    && typeof record.storedAt === "number"
    && record.storedAt <= now
    && now - record.storedAt < PDF_SOURCE_TTL_MS;
}
