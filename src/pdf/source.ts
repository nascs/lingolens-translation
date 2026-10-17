export const MAX_PDF_BYTES = 50 * 1024 * 1024;

const PDF_VIEWER_ORIGIN = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai";
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);
const ALLOWED_CONTENT_TYPES = new Set([
  "",
  "application/pdf",
  "application/x-pdf",
  "application/octet-stream",
  "application/binary",
  "application/download",
  "application/force-download",
  "binary/octet-stream"
]);

class PdfLoadError extends Error {}

export function parsePdfSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PDF 来源地址无效。");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol) || url.username || url.password) {
    throw new Error("PDF 来源地址无效。");
  }
  url.hash = "";
  return url;
}

export function extractPdfSourceFromTabUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  let tabUrl: URL;
  try {
    tabUrl = new URL(value);
  } catch {
    return undefined;
  }

  if (["http:", "https:", "file:"].includes(tabUrl.protocol) && /\.pdf$/i.test(tabUrl.pathname)) {
    try {
      return parsePdfSourceUrl(tabUrl.href);
    } catch {
      return undefined;
    }
  }

  const builtInViewer = `${tabUrl.protocol}//${tabUrl.host}` === PDF_VIEWER_ORIGIN && tabUrl.pathname === "/index.html";
  if (!builtInViewer) return undefined;
  const source = tabUrl.searchParams.get("file");
  if (!source) return undefined;
  try {
    return parsePdfSourceUrl(source);
  } catch {
    return undefined;
  }
}

export function pdfSourcePermissionPattern(source: URL): string | undefined {
  return source.protocol === "http:" || source.protocol === "https:" ? `${source.origin}/*` : undefined;
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function assertPdf(bytes: Uint8Array): Uint8Array {
  if (!hasPdfMagic(bytes)) throw new PdfLoadError("文件不是有效的 PDF。");
  return bytes;
}

async function readPdfResponse(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw new PdfLoadError("无法读取 PDF。");

  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_PDF_BYTES) throw new PdfLoadError("PDF 大小超过 50 MiB 限制。");
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new PdfLoadError("服务器返回的文件类型不是 PDF。");

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfLoadError("PDF 大小超过 50 MiB 限制。");
    return assertPdf(bytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PDF_BYTES) {
      await reader.cancel();
      throw new PdfLoadError("PDF 大小超过 50 MiB 限制。");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return assertPdf(bytes);
}

export async function loadPdfFromUrl(source: URL, signal?: AbortSignal): Promise<Uint8Array> {
  try {
    return await readPdfResponse(await fetch(source.href, { redirect: "error", signal }));
  } catch (error) {
    if (error instanceof PdfLoadError) throw error;
    throw new PdfLoadError("无法读取 PDF。");
  }
}

export async function loadPdfFromFile(file: File): Promise<Uint8Array> {
  try {
    if (file.size > MAX_PDF_BYTES) throw new PdfLoadError("PDF 大小超过 50 MiB 限制。");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfLoadError("PDF 大小超过 50 MiB 限制。");
    return assertPdf(bytes);
  } catch (error) {
    if (error instanceof PdfLoadError) throw error;
    throw new PdfLoadError("无法读取 PDF 文件。");
  }
}
