import "./styles.css";
import { extractPdfSourceFromTabUrl, pdfSourcePermissionPattern } from "../pdf/source";
import { loadSettings } from "../shared/config";
import { resolveTargetLanguage } from "../shared/language";
import type { PageStatus, Response, TranslationResult } from "../shared/messages";

function element<T extends HTMLElement>(id: string): T { const found = document.getElementById(id); if (!found) throw new Error(`Missing element #${id}`); return found as T; }
const startButton = element<HTMLButtonElement>("start-button");
const pauseButton = element<HTMLButtonElement>("pause-button");
const restoreButton = element<HTMLButtonElement>("restore-button");
const statusText = element("status-text");
const statusBadge = element("status-badge");
const providerLabel = element("provider-label");
const notice = element("notice");
const pdfButton = element<HTMLButtonElement>("pdf-button");
const exportButton = element<HTMLButtonElement>("export-button");
const quickSource = element<HTMLTextAreaElement>("quick-source");
const quickTranslate = element<HTMLButtonElement>("quick-translate");
const quickCopy = element<HTMLButtonElement>("quick-copy");
const quickResult = element("quick-result");
const quickNote = element("quick-note");
const quickRoute = element("quick-route");
let quickTranslated = "";
let tabId: number | undefined;
let capturedTabId: number | undefined;
let pdfSource: URL | undefined;
let ordinaryWebPage = false;
let configured = false;
let pageErrorNoticeActive = false;

function showNotice(message: string): void { notice.textContent = message; notice.hidden = !message; }
function render(status: PageStatus): void {
  const labels: Record<PageStatus["state"], string> = { idle: "未开始", translating: "翻译中", paused: "已暂停", completed: "自动跟随", error: "自动重试中" };
  statusBadge.textContent = labels[status.state]; statusBadge.dataset.state = status.state;
  const active = status.state !== "idle";
  pauseButton.disabled = !active || status.state === "error"; restoreButton.disabled = !active;
  pauseButton.textContent = status.state === "paused" ? "继续" : "暂停";
  startButton.disabled = !configured || (active && status.state !== "error");
  const strong = startButton.querySelector("strong"); if (strong) strong.textContent = status.state === "error" ? "立即重试" : "翻译此页面";
  const hint = startButton.querySelector("small"); if (hint) hint.textContent = active && status.state !== "error" ? "滚动页面自动翻译新增内容" : "原文与译文逐段呈现";
  statusText.textContent = status.state === "error" ? "网络或服务暂时不可用，正在自动重试…" : (status.error ?? (active ? "译文会紧随原文出现，滚动页面自动翻译新增内容。" : "点击后仅处理当前页面的可读段落。"));
  if (status.error) { showNotice(status.error); pageErrorNoticeActive = true; }
  else if (pageErrorNoticeActive && configured) { showNotice(""); pageErrorNoticeActive = false; }
}
async function sendPage<T>(message: object): Promise<T> { if (!tabId) throw new Error("当前页面不可用。"); return chrome.tabs.sendMessage(tabId, message) as Promise<T>; }
async function initialize(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) throw new Error("找不到当前标签页。");
    tabId = tab.id;
    capturedTabId = tab.id;
    pdfSource = extractPdfSourceFromTabUrl(tab.url);
    let protocol = "";
    try { protocol = tab.url ? new URL(tab.url).protocol : ""; } catch { /* Protected or transient tab URL. */ }
    ordinaryWebPage = (protocol === "http:" || protocol === "https:") && !pdfSource;

    const settings = await loadSettings(); configured = Boolean(settings.apiKey && settings.baseUrl && settings.model);
    providerLabel.textContent = `${settings.provider === "custom" ? "兼容服务" : settings.provider === "openai" ? "OpenAI" : "DeepSeek"} · ${settings.model || "未设置模型"}`;
    if (!configured) showNotice("先填写 API Key，即可开始双语阅读。");
    if (ordinaryWebPage) {
      try { render(await sendPage<PageStatus>({ type: "PAGE_GET_STATUS" })); }
      catch { render({ state: "idle", total: 0, completed: 0 }); }
    } else {
      startButton.disabled = true;
      statusText.textContent = pdfSource ? "当前 PDF 可在双栏阅读器中打开。" : "此页面不支持网页原位翻译，可打开独立翻译或 PDF 阅读器。";
    }
  } catch { startButton.disabled = true; showNotice("无法读取当前页面状态。"); statusText.textContent = "Chrome 内部页面、扩展商店等受保护页面无法翻译。"; }
}
startButton.addEventListener("click", async () => {
  if (!ordinaryWebPage) return;
  startButton.disabled = true;
  showNotice("");
  try {
    const injection = await chrome.runtime.sendMessage({ type: "INJECT_ACTIVE_TAB" }) as Response<{ tabId: number }>;
    if (!injection.ok) throw new Error(injection.error);
    tabId = injection.data.tabId;
    const settings = await loadSettings();
    render(await sendPage<PageStatus>({ type: "PAGE_START", style: settings.translationStyle }));
  } catch { startButton.disabled = false; showNotice("此页面不支持扩展脚本。"); }
});
pauseButton.addEventListener("click", async () => render(await sendPage<PageStatus>({ type: "PAGE_TOGGLE_PAUSE" })));
restoreButton.addEventListener("click", async () => render(await sendPage<PageStatus>({ type: "PAGE_RESTORE" })));
pdfButton.addEventListener("click", async () => {
  pdfButton.disabled = true;
  showNotice("");
  try {
    const targetTabId = capturedTabId;
    if (targetTabId === undefined) throw new Error("当前页面不可用。");
    let sourceUrl: string | undefined;
    const source = pdfSource;
    const pattern = source ? pdfSourcePermissionPattern(source) : undefined;
    if (pattern) {
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) { showNotice("需要来源站点访问权限才能读取此 PDF，可再次点击授权。"); return; }
      sourceUrl = source?.href;
    } else if (source?.protocol === "file:" && await chrome.extension.isAllowedFileSchemeAccess()) {
      sourceUrl = source.href;
    }
    const response = await chrome.runtime.sendMessage({ type: "OPEN_PDF_VIEWER", tabId: targetTabId, ...(sourceUrl ? { sourceUrl } : {}) }) as Response<{ tabId: number }>;
    if (!response.ok) throw new Error(response.error);
  } catch { showNotice("无法打开 PDF 阅读器，请重试。"); }
  finally { pdfButton.disabled = false; }
});
async function translateQuickText(): Promise<void> {
  const text = quickSource.value.trim();
  if (!text) { quickNote.classList.remove("is-error"); quickNote.textContent = "先输入要翻译的文本。"; quickSource.focus(); return; }
  quickTranslate.disabled = true;
  quickNote.classList.remove("is-error");
  quickNote.textContent = "正在翻译…";
  quickResult.hidden = true;
  try {
    const decision = await resolveTargetLanguage(text, "smart");
    quickRoute.textContent = decision.label;
    const settings = await loadSettings();
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_BATCH",
      items: [{ id: "popup", text }],
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: decision.resolvedTargetLanguage
    }) as Response<TranslationResult[]>;
    if (!response.ok) throw new Error(response.error);
    const translated = response.data[0]?.text ?? "";
    if (!translated) throw new Error("没有收到译文。");
    quickTranslated = translated;
    quickResult.textContent = translated;
    quickResult.hidden = false;
    quickCopy.disabled = false;
    quickNote.textContent = "";
  } catch (error) {
    quickTranslated = "";
    quickCopy.disabled = true;
    quickResult.hidden = true;
    quickNote.classList.add("is-error");
    quickNote.textContent = error instanceof Error ? error.message : "翻译失败";
  } finally {
    quickTranslate.disabled = false;
  }
}
quickTranslate.addEventListener("click", () => void translateQuickText());
quickSource.addEventListener("keydown", (event) => {
  if (event.ctrlKey && (event.key === "Enter" || event.key === "NumpadEnter")) { event.preventDefault(); void translateQuickText(); }
});
quickCopy.addEventListener("click", async () => {
  if (!quickTranslated) return;
  try {
    await navigator.clipboard.writeText(quickTranslated);
    quickNote.classList.remove("is-error");
    quickCopy.textContent = "已复制";
  } catch {
    quickNote.classList.add("is-error");
    quickNote.textContent = "复制失败，请手动选择译文。";
  }
  window.setTimeout(() => { quickCopy.textContent = "复制"; }, 1200);
});
exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  showNotice("");
  try {
    const result = await sendPage<{ count: number; markdown: string; filename: string }>({ type: "PAGE_EXPORT_TRANSLATIONS" });
    if (!result.count) { showNotice("当前页面暂无可导出的译文，请先翻译此页面。"); return; }
    const blob = new Blob([result.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    showNotice(`已导出 ${result.count} 条译文。`);
  } catch {
    showNotice("导出失败，请先翻译此页面后重试。");
  } finally {
    exportButton.disabled = false;
  }
});
element<HTMLButtonElement>("settings-button").addEventListener("click", () => void chrome.runtime.openOptionsPage());
element<HTMLButtonElement>("translator-button").addEventListener("click", () => void chrome.runtime.sendMessage({ type: "OPEN_TRANSLATOR" }));
chrome.runtime.onMessage.addListener((message: unknown) => { if (typeof message === "object" && message !== null && "type" in message && message.type === "PAGE_STATUS_CHANGED" && "status" in message) render(message.status as PageStatus); });
void initialize();
