import { describe, expect, it } from "vitest";
import {
  PDF_SOURCE_TTL_MS,
  createPdfSourceRecord,
  isExactSenderPage,
  isFreshPdfSourceRecord,
  isValidPdfTabId,
  pdfSourceMatchesTab,
  pdfSourceStorageKey
} from "./pdf-source";

describe("PDF source session helpers", () => {
  it("uses a per-tab storage key", () => {
    expect(pdfSourceStorageKey(42)).toBe("pdf-source:42");
  });

  it("accepts only an exact sender page", () => {
    const expected = "chrome-extension://extension-id/pdf.html";
    expect(isExactSenderPage(expected, expected)).toBe(true);
    expect(isExactSenderPage(`${expected}?source=secret`, expected)).toBe(false);
    expect(isExactSenderPage("chrome-extension://extension-id/popup.html", expected)).toBe(false);
    expect(isExactSenderPage(undefined, expected)).toBe(false);
  });

  it("accepts only positive integer tab ids", () => {
    expect(isValidPdfTabId(1)).toBe(true);
    expect(isValidPdfTabId(42)).toBe(true);
    expect(isValidPdfTabId(0)).toBe(false);
    expect(isValidPdfTabId(-1)).toBe(false);
    expect(isValidPdfTabId(1.5)).toBe(false);
    expect(isValidPdfTabId("1")).toBe(false);
  });

  it("matches a source against the captured tab rather than another active tab", () => {
    const source = "https://documents.example/report.pdf?token=private";
    const capturedTabUrl = source;
    const laterActiveTabUrl = "https://other.example/other.pdf";
    expect(pdfSourceMatchesTab(source, capturedTabUrl)).toBe(true);
    expect(pdfSourceMatchesTab(source, laterActiveTabUrl)).toBe(false);
    expect(pdfSourceMatchesTab(undefined, laterActiveTabUrl)).toBe(true);
    expect(pdfSourceMatchesTab("data:application/pdf,no", capturedTabUrl)).toBe(false);
  });

  it("creates records and enforces the ten-minute TTL", () => {
    const now = 1_000_000;
    const record = createPdfSourceRecord("https://example.com/a.pdf", now);
    expect(record).toEqual({ sourceUrl: "https://example.com/a.pdf", storedAt: now });
    expect(isFreshPdfSourceRecord(record, now + PDF_SOURCE_TTL_MS - 1)).toBe(true);
    expect(isFreshPdfSourceRecord(record, now + PDF_SOURCE_TTL_MS)).toBe(false);
    expect(isFreshPdfSourceRecord(record, now - 1)).toBe(false);
  });

  it("rejects malformed records", () => {
    expect(isFreshPdfSourceRecord(null)).toBe(false);
    expect(isFreshPdfSourceRecord({ sourceUrl: "", storedAt: Date.now() })).toBe(false);
    expect(isFreshPdfSourceRecord({ sourceUrl: 1, storedAt: Date.now() })).toBe(false);
    expect(isFreshPdfSourceRecord({ sourceUrl: "ok", storedAt: "now" })).toBe(false);
  });
});
