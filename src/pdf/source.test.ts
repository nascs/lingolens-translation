import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PDF_BYTES,
  extractPdfSourceFromTabUrl,
  loadPdfFromFile,
  loadPdfFromUrl,
  parsePdfSourceUrl,
  pdfSourcePermissionPattern
} from "./source";

const PDF = new TextEncoder().encode("%PDF-1.7\nbody");

afterEach(() => vi.unstubAllGlobals());

describe("PDF source URL parsing", () => {
  it.each(["https://example.com/a.pdf", "http://example.com/a.pdf", "file:///tmp/a.pdf"])("accepts %s", (value) => {
    expect(parsePdfSourceUrl(value).protocol).toMatch(/^(https?|file):$/);
  });

  it.each([
    "javascript:alert(1)",
    "data:application/pdf;base64,JVBERg==",
    "chrome://settings/a.pdf",
    "chrome-extension://id/a.pdf"
  ])("rejects unsafe source %s without reflecting it", (value) => {
    expect(() => parsePdfSourceUrl(value)).toThrow("PDF 来源地址无效。");
    try { parsePdfSourceUrl(value); } catch (error) { expect(String(error)).not.toContain(value); }
  });

  it("rejects URL credentials without reflecting them", () => {
    const value = new URL("https://example.com/a.pdf");
    value.username = "placeholder";
    value.password = "placeholder";
    expect(() => parsePdfSourceUrl(value.href)).toThrow("PDF 来源地址无效。");
    try { parsePdfSourceUrl(value.href); } catch (error) { expect(String(error)).not.toContain("placeholder"); }
  });

  it("uses .pdf only as a normal-tab routing hint", () => {
    expect(extractPdfSourceFromTabUrl("https://example.com/file.PDF?token=secret")?.href).toBe("https://example.com/file.PDF?token=secret");
    expect(extractPdfSourceFromTabUrl("https://example.com/document?format=pdf")).toBeUndefined();
  });

  it("extracts and revalidates Chrome viewer file parameters", () => {
    const viewer = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?file=";
    expect(extractPdfSourceFromTabUrl(`${viewer}${encodeURIComponent("https://example.com/a.pdf?x=1")}`)?.href).toBe("https://example.com/a.pdf?x=1");
    expect(extractPdfSourceFromTabUrl(`${viewer}${encodeURIComponent("data:text/plain,no")}`)).toBeUndefined();
    expect(extractPdfSourceFromTabUrl("chrome-extension://other/index.html?file=https://example.com/a.pdf")).toBeUndefined();
  });

  it("returns exact HTTP(S) origin permissions but none for file", () => {
    expect(pdfSourcePermissionPattern(parsePdfSourceUrl("https://example.com:8443/a.pdf"))).toBe("https://example.com:8443/*");
    expect(pdfSourcePermissionPattern(parsePdfSourceUrl("http://example.com/a.pdf"))).toBe("http://example.com/*");
    expect(pdfSourcePermissionPattern(parsePdfSourceUrl("file:///tmp/a.pdf"))).toBeUndefined();
  });
});

describe("PDF loading", () => {
  it("uses redirect:error and the supplied signal", async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async () => new Response(PDF, { headers: { "content-type": "application/pdf" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf?secret=yes"), signal)).resolves.toEqual(PDF);
    expect(fetchMock).toHaveBeenCalledWith("https://example.com/a.pdf?secret=yes", { redirect: "error", signal });
  });

  it.each(["application/pdf", "application/octet-stream", ""])("accepts %j content type with PDF magic", async (contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF, { headers: contentType ? { "content-type": contentType } : {} })));
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf"))).resolves.toEqual(PDF);
  });

  it("rejects incompatible content type and bad magic", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF, { headers: { "content-type": "text/html" } })));
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf"))).rejects.toThrow("文件类型不是 PDF");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not pdf", { headers: { "content-type": "application/pdf" } })));
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf"))).rejects.toThrow("不是有效的 PDF");
  });

  it("rejects oversized Content-Length before reading", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF, { headers: { "content-length": String(MAX_PDF_BYTES + 1) } })));
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf"))).rejects.toThrow("50 MiB");
  });

  it("rejects a stream that exceeds the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF);
        controller.enqueue(new Uint8Array(MAX_PDF_BYTES));
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "application/pdf" } })));
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf"))).rejects.toThrow("50 MiB");
  });

  it("keeps network errors free of URL and query data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("https://example.com/a.pdf?token=secret"); }));
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf?token=secret"))).rejects.toThrow("无法读取 PDF。");
    try { await loadPdfFromUrl(new URL("https://example.com/a.pdf?token=secret")); } catch (error) {
      expect(String(error)).not.toContain("example.com");
      expect(String(error)).not.toContain("secret");
    }
  });

  it("sanitizes stream and local read errors", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("https://example.com/a.pdf?token=secret")); } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "application/pdf" } })));
    await expect(loadPdfFromUrl(new URL("https://example.com/a.pdf?token=secret"))).rejects.toThrow("无法读取 PDF。");
    const file = { size: 1, arrayBuffer: async () => { throw new Error("private-path.pdf"); } } as unknown as File;
    await expect(loadPdfFromFile(file)).rejects.toThrow("无法读取 PDF 文件。");
  });

  it("checks local file size and magic without reflecting its name", async () => {
    await expect(loadPdfFromFile(new File([PDF], "private.pdf"))).resolves.toEqual(PDF);
    const bad = new File(["bad"], "secret-path.pdf");
    try { await loadPdfFromFile(bad); } catch (error) { expect(String(error)).not.toContain(bad.name); }
    const oversized = { size: MAX_PDF_BYTES + 1, arrayBuffer: vi.fn() } as unknown as File;
    await expect(loadPdfFromFile(oversized)).rejects.toThrow("50 MiB");
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });
});
