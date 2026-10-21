import { loadSettings, normalizeSettings, validateTransport, type Settings } from "../shared/config";
import { parsePdfSourceUrl, pdfSourcePermissionPattern } from "../pdf/source";
import { errorMessage, type BackgroundRequest, type PdfSourceRecord, type PdfSourceResponse, type Response, type TranslationItem, type TranslationResult } from "../shared/messages";
import { translateBatch, translateImage, TranslationApiError } from "./api";
import { createPdfSourceRecord, isExactSenderPage, isFreshPdfSourceRecord, isValidPdfTabId, pdfSourceMatchesTab, pdfSourceStorageKey } from "./pdf-source";
import { PdfTranslationCancelledError, PdfTranslationManager } from "./pdf-translations";

const translationCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 400;
const CACHE_STORAGE_KEY = "lingolens:translation-cache:v1";
let cacheLoad: Promise<void> | undefined;
const pdfTranslationManager = new PdfTranslationManager();

/** 首次使用时从 storage.local 恢复持久缓存；Service Worker 重启后仍可命中，避免重复消耗额度。 */
async function ensureCacheLoaded(): Promise<void> {
  if (!cacheLoad) {
    cacheLoad = (async () => {
      try {
        const stored = await chrome.storage.local.get(CACHE_STORAGE_KEY);
        const raw = stored[CACHE_STORAGE_KEY];
        if (!Array.isArray(raw)) return;
        for (const entry of raw) {
          if (!Array.isArray(entry) || entry.length !== 2) continue;
          const [key, value] = entry;
          if (typeof key !== "string" || typeof value !== "string" || !key || !value) continue;
          translationCache.set(key, value);
        }
        while (translationCache.size > MAX_CACHE_ENTRIES) {
          const oldest = translationCache.keys().next().value;
          if (typeof oldest !== "string") break;
          translationCache.delete(oldest);
        }
      } catch {
        // 缓存恢复失败不影响翻译；继续使用内存缓存。
      }
    })();
  }
  await cacheLoad;
}

function persistCache(): void {
  void chrome.storage.local
    .set({ [CACHE_STORAGE_KEY]: Array.from(translationCache.entries()) })
    .catch(() => {});
}

async function cacheKey(settings: Settings, item: TranslationItem, sourceLanguage: string, targetLanguage: string): Promise<string> {
  const value = [settings.baseUrl, settings.model, sourceLanguage, targetLanguage, settings.glossary, item.text].join("\u0000");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function writeCache(key: string, value: string): void {
  translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > MAX_CACHE_ENTRIES) {
    const oldest = translationCache.keys().next().value;
    if (typeof oldest !== "string") break;
    translationCache.delete(oldest);
  }
}

async function translateWithCache(
  settings: Settings,
  items: TranslationItem[],
  sourceLanguage: string,
  targetLanguage: string,
  signal?: AbortSignal
): Promise<TranslationResult[]> {
  const throwIfCancelled = (): void => {
    if (signal?.aborted) throw new TranslationApiError("PDF 翻译已取消。", "CANCELLED");
  };
  throwIfCancelled();
  await ensureCacheLoaded();
  const keys = await Promise.all(items.map((item) => cacheKey(settings, item, sourceLanguage, targetLanguage)));
  throwIfCancelled();
  const resolved = new Map<string, string>();
  const missing: TranslationItem[] = [];
  const cacheHits: Array<[string, string]> = [];
  const cacheWrites: Array<[string, string]> = [];

  items.forEach((item, index) => {
    const key = keys[index];
    const cached = key ? translationCache.get(key) : undefined;
    if (cached && key) {
      resolved.set(item.id, cached);
      cacheHits.push([key, cached]);
    } else {
      missing.push(item);
    }
  });

  if (missing.length > 0) {
    const translated = await translateBatch(settings, missing, sourceLanguage, targetLanguage, signal);
    throwIfCancelled();
    const indexById = new Map(items.map((item, index) => [item.id, index]));
    for (const result of translated) {
      resolved.set(result.id, result.text);
      const index = indexById.get(result.id);
      const key = index === undefined ? undefined : keys[index];
      if (key) cacheWrites.push([key, result.text]);
    }
  }

  throwIfCancelled();
  for (const [key, value] of [...cacheHits, ...cacheWrites]) writeCache(key, value);
  if (cacheHits.length || cacheWrites.length) persistCache();
  return items.map((item) => {
    const text = resolved.get(item.id);
    if (!text) throw new TranslationApiError("翻译缓存返回不完整。", "INCOMPLETE_RESPONSE");
    return { id: item.id, text };
  });
}

async function activeTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("找不到当前标签页。");
  return { ...tab, id: tab.id };
}

async function activeTabId(): Promise<number> {
  return (await activeTab()).id;
}

async function injectTab(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PAGE_GET_STATUS" });
  } catch {
    await Promise.all([
      chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] }),
      chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })
    ]);
  }
}

type PdfRequest = Extract<BackgroundRequest, { type: "OPEN_PDF_VIEWER" | "SET_PDF_SOURCE" | "GET_PDF_SOURCE" | "CLEAR_PDF_SOURCE" | "CANCEL_PDF_TRANSLATIONS" }>;

async function assertPdfPermission(source: URL): Promise<void> {
  const pattern = pdfSourcePermissionPattern(source);
  const allowed = pattern
    ? await chrome.permissions.contains({ origins: [pattern] })
    : await chrome.extension.isAllowedFileSchemeAccess();
  if (!allowed) throw new Error("尚未授予 PDF 来源访问权限。");
}

async function storePdfSource(tabId: number, source: URL): Promise<PdfSourceRecord> {
  await assertPdfPermission(source);
  const record = createPdfSourceRecord(source.href);
  await chrome.storage.session.set({ [pdfSourceStorageKey(tabId)]: record });
  return record;
}

async function readPdfSource(tabId: number): Promise<PdfSourceRecord | null> {
  const key = pdfSourceStorageKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const record = stored[key];
  if (isFreshPdfSourceRecord(record)) return record;
  if (record !== undefined) await chrome.storage.session.remove(key);
  return null;
}

async function clearPdfSource(tabId: number): Promise<void> {
  await chrome.storage.session.remove(pdfSourceStorageKey(tabId));
}

async function handlePdfMessage(message: PdfRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) throw new Error("无效的 PDF 请求。");
  try {
    if (message.type === "OPEN_PDF_VIEWER") {
      if (!isExactSenderPage(sender.url, chrome.runtime.getURL("popup.html"))) throw new Error("无效的 PDF 请求。");
      if (!isValidPdfTabId(message.tabId)) throw new Error("无效的 PDF 请求。");
      const tabId = message.tabId;
      const tab = await chrome.tabs.get(tabId);
      if (tab.id !== tabId || !pdfSourceMatchesTab(message.sourceUrl, tab.url)) throw new Error("PDF 来源与目标标签页不匹配。");
      if (message.sourceUrl !== undefined) {
        const requested = parsePdfSourceUrl(message.sourceUrl);
        await storePdfSource(tabId, requested);
      } else {
        await clearPdfSource(tabId);
      }
      try {
        await chrome.tabs.update(tabId, { url: chrome.runtime.getURL("pdf.html") });
      } catch {
        await clearPdfSource(tabId);
        throw new Error("无法打开 PDF 阅读器。");
      }
      return { tabId };
    }

    if (!isExactSenderPage(sender.url, chrome.runtime.getURL("pdf.html")) || !isValidPdfTabId(sender.tab?.id)) {
      throw new Error("无效的 PDF 请求。");
    }
    const tabId = sender.tab.id;
    if (message.type === "CANCEL_PDF_TRANSLATIONS") {
      await pdfTranslationManager.cancelAndWait(tabId);
      return { cancelled: true };
    }
    if (message.type === "SET_PDF_SOURCE") {
      const source = await storePdfSource(tabId, parsePdfSourceUrl(message.sourceUrl));
      return { source } satisfies PdfSourceResponse;
    }
    if (message.type === "GET_PDF_SOURCE") {
      return { source: await readPdfSource(tabId) } satisfies PdfSourceResponse;
    }
    await clearPdfSource(tabId);
    return { source: null } satisfies PdfSourceResponse;
  } catch {
    throw new Error("无法处理 PDF 请求。");
  }
}

export async function handleMessage(message: BackgroundRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "INJECT_ACTIVE_TAB": {
      const tabId = await activeTabId();
      await injectTab(tabId);
      return { tabId };
    }
    case "OPEN_TRANSLATOR": {
      await chrome.tabs.create({ url: chrome.runtime.getURL("translator.html") });
      return { opened: true };
    }
    case "OPEN_QUICK_WINDOW": {
      const hash = message.view === "image" ? "#image" : "";
      await chrome.windows.create({
        url: chrome.runtime.getURL(`quick.html${hash}`),
        type: "popup",
        width: 540,
        height: 760
      });
      return { opened: true };
    }
    case "OPEN_OPTIONS": {
      await chrome.runtime.openOptionsPage();
      return { opened: true };
    }
    case "OPEN_PDF_VIEWER":
    case "SET_PDF_SOURCE":
    case "GET_PDF_SOURCE":
    case "CLEAR_PDF_SOURCE":
    case "CANCEL_PDF_TRANSLATIONS":
      return handlePdfMessage(message, sender);
    case "TRANSLATE_IMAGE": {
      const settings = await loadSettings();
      validateTransport(settings.baseUrl, settings.allowInsecureHttp);
      return translateImage(settings, message.imageDataUrl, message.sourceLanguage, message.targetLanguage);
    }
    case "TRANSLATE_BATCH": {
      const settings = await loadSettings();
      validateTransport(settings.baseUrl, settings.allowInsecureHttp);
      if (isExactSenderPage(sender.url, chrome.runtime.getURL("pdf.html"))) {
        if (sender.id !== chrome.runtime.id || !isValidPdfTabId(sender.tab?.id)) throw new Error("无效的 PDF 翻译请求。");
        return pdfTranslationManager.run(sender.tab.id, (signal) => translateWithCache(
          settings,
          message.items,
          message.sourceLanguage,
          message.targetLanguage,
          signal
        ));
      }
      return translateWithCache(settings, message.items, message.sourceLanguage, message.targetLanguage);
    }
    case "TEST_PROVIDER": {
      const settings = normalizeSettings(message.settings);
      validateTransport(settings.baseUrl, settings.allowInsecureHttp);
      await translateBatch(settings, [{ id: "test", text: "Hello, world." }], "English", settings.targetLanguage);
      return { message: "连接成功" };
    }
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, sender, sendResponse: (response: Response<unknown>) => void) => {
  void handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error: unknown) => {
      const code = error instanceof TranslationApiError || error instanceof PdfTranslationCancelledError ? error.code : undefined;
      sendResponse({ ok: false, error: errorMessage(error), code });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "lingolens-selection", title: "用 LingoLens 翻译“%s”", contexts: ["selection"] });
});

async function toggleCurrentPage(): Promise<void> {
  const tabId = await activeTabId();
  await injectTab(tabId);
  const status = await chrome.tabs.sendMessage(tabId, { type: "PAGE_GET_STATUS" });
  const nextType = status?.state === "idle" ? "PAGE_START" : "PAGE_RESTORE";
  const settings = await loadSettings();
  await chrome.tabs.sendMessage(tabId, { type: nextType, style: settings.translationStyle });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "translate-page") void toggleCurrentPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "lingolens-selection" || !info.selectionText || !tab?.id) return;
  void injectTab(tab.id).then(() => chrome.tabs.sendMessage(tab.id!, { type: "PAGE_TRANSLATE_SELECTION", text: info.selectionText }));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearPdfSource(tabId);
  void pdfTranslationManager.clearTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url !== undefined && changeInfo.url !== chrome.runtime.getURL("pdf.html")) {
    void clearPdfSource(tabId);
    void pdfTranslationManager.clearTab(tabId);
  }
});

export type TranslationBatchResponse = Response<TranslationResult[]>;
