import "./styles.css";
import { loadSettings } from "../shared/config";
import type { PdfSourceResponse, Response, TranslationResult } from "../shared/messages";
import {
  MAX_DETECTION_PAGES,
  MAX_RENDERED_PAGE_PAIRS,
  DocumentTargetResolver,
  PdfDocumentHandle,
  applyCharacterLimit,
  planCanvasReconciliation,
  selectRetainedCanvasPages,
  type ExtractedPage,
  type PageCanvasSize,
  type PageImageRegion
} from "./document";
import { TranslationQueue, translationItemsForPage, type PdfTranslationItem } from "./queue";
import { loadPdfFromFile, loadPdfFromUrl, parsePdfSourceUrl, pdfSourcePermissionPattern } from "./source";
import {
  cancelAndClearTranslationQueue,
  clearCanvasBackingStore,
  clearPageCanvasPair,
  disposeAfterTranslationCancellation,
  handlePagePairRenderFailure
} from "./lifecycle";
import { drawTranslationText, fontString, layoutTranslation, type TranslationRunKind } from "./translation-layout";
import { buildPageTranslationState, type PageTranslationState } from "./translation-state";
import { majoritySerif, type SerifKind } from "./font-classify";
import { styleParagraphs } from "./style";
import type { ParagraphShape } from "./text";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

interface PageView {
  row: HTMLElement;
  canvasWrap: HTMLElement;
  canvas: HTMLCanvasElement;
  canvasDescription: HTMLElement;
  translationCanvas: HTMLCanvasElement;
  translationOverlay: HTMLElement;
  translationHidden: HTMLElement;
  copyButton: HTMLButtonElement;
  copyFeedback: HTMLElement;
  size?: PageCanvasSize;
  lastWidth: number;
}

const urlForm = element<HTMLFormElement>("url-form");
const urlInput = element<HTMLInputElement>("url-input");
const urlLoadButton = element<HTMLButtonElement>("url-load-button");
const fileInput = element<HTMLInputElement>("file-input");
const sourceLanguage = element<HTMLSelectElement>("source-language");
const targetLanguage = element<HTMLSelectElement>("target-language");
const translateButton = element<HTMLButtonElement>("translate-button");
const detectionResult = element("detection-result");
const statusTitle = element("status-title");
const statusMessage = element("status-message");
const pageProgress = element("page-progress");
const translationProgress = element("translation-progress");
const documentView = element("document-view");
const targetResolver = new DocumentTargetResolver();

let documentGeneration = 0;
let translationGeneration = 0;
let sourceActionGeneration = 0;
let abortController: AbortController | undefined;
let pdfDocument: PdfDocumentHandle | undefined;
let pageObserver: IntersectionObserver | undefined;
let resizeObserver: ResizeObserver | undefined;
let resizeAnimationFrame: number | undefined;
let translationQueue: TranslationQueue | undefined;
let extractionDone = false;
let characterLimitReached = false;
let translationStarted = false;
let usedCharacters = 0;
let totalItems = 0;
let completedItems = 0;
let failedBatches = 0;
let currentTarget = "";
const pageViews = new Map<number, PageView>();
const extractedPages = new Map<number, ExtractedPage>();
const itemsByPage = new Map<number, PdfTranslationItem[]>();
const translatedById = new Map<string, string>();
const failedItemIds = new Set<string>();
const queuedPages = new Set<number>();
const visiblePages = new Set<number>();
const renderedPages = new Set<number>();
const renderingPages = new Set<number>();
const cancelledRenderingPages = new Set<number>();
const failedRenderingPages = new Set<number>();
const pendingResizePages = new Set<number>();
const imageRegionsByPage = new Map<number, PageImageRegion[]>();
const imageRegionsPending = new Set<number>();
const serifVotes: Array<{ serif: SerifKind | undefined; chars: number }> = [];

function setStatus(title: string, message: string): void {
  statusTitle.textContent = title;
  statusMessage.textContent = message;
}

function setLoadingControls(loading: boolean): void {
  urlLoadButton.disabled = loading;
  fileInput.disabled = loading;
}

function updateProgress(): void {
  const pages = pdfDocument?.pageCount ?? 0;
  pageProgress.textContent = `页进度：${extractedPages.size} / ${pages}`;
  translationProgress.textContent = `翻译：${completedItems} / ${totalItems} 段`;
}

function availableCanvasWidth(view: PageView): number {
  return Math.max(1, view.canvasWrap.clientWidth - 24);
}

function stopObservingResize(pageNumber: number, view: PageView): void {
  resizeObserver?.unobserve(view.canvasWrap);
  pendingResizePages.delete(pageNumber);
}

function clearPagePair(pageNumber: number, view: PageView): void {
  stopObservingResize(pageNumber, view);
  clearPageCanvasPair(view.canvas, view.translationCanvas);
  view.size = undefined;
}

function clearResizeScheduling(): void {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  pendingResizePages.clear();
  if (resizeAnimationFrame !== undefined) cancelAnimationFrame(resizeAnimationFrame);
  resizeAnimationFrame = undefined;
}

function scheduleResizeReconciliation(generation: number): void {
  if (resizeAnimationFrame !== undefined) return;
  resizeAnimationFrame = requestAnimationFrame(() => {
    resizeAnimationFrame = undefined;
    if (generation !== documentGeneration) {
      pendingResizePages.clear();
      return;
    }
    const pages = [...pendingResizePages];
    pendingResizePages.clear();
    for (const pageNumber of pages) {
      const view = pageViews.get(pageNumber);
      if (!view || !renderedPages.has(pageNumber)) continue;
      clearPagePair(pageNumber, view);
      renderedPages.delete(pageNumber);
    }
    reconcileCanvasRendering(generation);
  });
}

function createResizeObserver(generation: number): void {
  clearResizeScheduling();
  resizeObserver = new ResizeObserver((entries) => {
    if (generation !== documentGeneration) return;
    for (const entry of entries) {
      const pageNumber = Number((entry.target as HTMLElement).dataset.page);
      const view = pageViews.get(pageNumber);
      if (!view || !renderedPages.has(pageNumber)) continue;
      const width = availableCanvasWidth(view);
      if (Math.abs(width - view.lastWidth) < 1) continue;
      view.lastWidth = width;
      pendingResizePages.add(pageNumber);
    }
    if (pendingResizePages.size) scheduleResizeReconciliation(generation);
  });
}

function setTranslationCanvasSize(canvas: HTMLCanvasElement, size: PageCanvasSize): CanvasRenderingContext2D | undefined {
  if (canvas.width !== size.backingWidth) canvas.width = size.backingWidth;
  if (canvas.height !== size.backingHeight) canvas.height = size.backingHeight;
  canvas.style.width = `${size.cssWidth}px`;
  canvas.style.height = `${size.cssHeight}px`;
  const context = canvas.getContext("2d") ?? undefined;
  context?.setTransform(size.backingWidth / size.cssWidth, 0, 0, size.backingHeight / size.cssHeight, 0, 0);
  return context;
}

function currentTranslationState(pageNumber: number): PageTranslationState {
  return buildPageTranslationState(itemsByPage.get(pageNumber) ?? [], translatedById, failedItemIds);
}

function drawTranslationPlaceholder(context: CanvasRenderingContext2D, size: PageCanvasSize, message: string): void {
  context.save();
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, size.cssWidth, size.cssHeight);
  context.fillStyle = "#74817b";
  context.font = "14px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(message, size.cssWidth / 2, size.cssHeight / 2, Math.max(1, size.cssWidth - 48));
  context.restore();
}

function fillTranslationBackground(context: CanvasRenderingContext2D, size: PageCanvasSize): void {
  context.fillStyle = "#fffdf8";
  context.fillRect(0, 0, size.cssWidth, size.cssHeight);
}

function drawTranslationNotice(
  context: CanvasRenderingContext2D,
  size: PageCanvasSize,
  message: string,
  regions: readonly PageImageRegion[]
): void {
  context.save();
  const { cssWidth, cssHeight } = size;
  const padding = Math.min(48, Math.max(24, cssWidth * 0.06));
  const slotHeight = 26;
  const footerTop = Math.max(padding, cssHeight - padding - 32);
  const maxTextWidth = Math.max(1, cssWidth - 48);
  let y: number | undefined;
  for (let candidate = padding; candidate + slotHeight <= footerTop; candidate += 8) {
    if (regions.every((region) => {
      const top = region.y * cssHeight;
      const bottom = (region.y + region.height) * cssHeight;
      return candidate + slotHeight <= top || candidate >= bottom;
    })) {
      y = candidate;
      break;
    }
  }
  context.fillStyle = "#74817b";
  context.font = "14px system-ui, sans-serif";
  context.textAlign = "center";
  if (y !== undefined) {
    context.textBaseline = "top";
    context.fillText(message, cssWidth / 2, y, maxTextWidth);
  } else {
    context.textBaseline = "middle";
    const textWidth = Math.min(context.measureText(message).width, maxTextWidth);
    context.fillStyle = "#fffdf8";
    context.fillRect(cssWidth / 2 - textWidth / 2 - 12, 30, textWidth + 24, 30);
    context.fillStyle = "#74817b";
    context.fillText(message, cssWidth / 2, 45, maxTextWidth);
  }
  context.restore();
}

function drawImageRegions(context: CanvasRenderingContext2D, view: PageView, size: PageCanvasSize, regions: readonly PageImageRegion[]): void {
  if (!regions.length || view.canvas.width <= 0 || view.canvas.height <= 0) return;
  const { backingWidth, backingHeight, cssWidth, cssHeight } = size;
  for (const region of regions) {
    const sx = region.x * backingWidth;
    const sy = region.y * backingHeight;
    const sw = region.width * backingWidth;
    const sh = region.height * backingHeight;
    const dx = region.x * cssWidth;
    const dy = region.y * cssHeight;
    const dw = region.width * cssWidth;
    const dh = region.height * cssHeight;
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) continue;
    if (!Number.isFinite(sw) || !Number.isFinite(sh) || !Number.isFinite(dw) || !Number.isFinite(dh)) continue;
    context.drawImage(view.canvas, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

function drawPageTranslation(pageNumber: number, view: PageView, state: PageTranslationState): void {
  const size = view.size;
  if (!size) return;
  const context = setTranslationCanvasSize(view.translationCanvas, size);
  if (!context) return;
  const regions = imageRegionsByPage.get(pageNumber) ?? [];
  if (!state.paragraphs.length) {
    const page = extractedPages.get(pageNumber);
    const message = page && !page.paragraphs.length
      ? "该页没有可提取文本，暂不支持扫描件 OCR"
      : state.status === "partial" ? "部分译文尚不可用，可重试失败批次" : "等待译文";
    if (regions.length) {
      fillTranslationBackground(context, size);
      drawImageRegions(context, view, size, regions);
      drawTranslationNotice(context, size, message, regions);
    } else {
      drawTranslationPlaceholder(context, size, message);
    }
    return;
  }
  fillTranslationBackground(context, size);
  drawImageRegions(context, view, size, regions);
  const measureText = (text: string, fontSize: number, kind: TranslationRunKind, serif: SerifKind, weight: 400 | 700): number => {
    context.font = fontString(serif, kind, fontSize, weight);
    return context.measureText(text).width;
  };
  const layout = layoutTranslation(state.paragraphs, size.cssWidth, size.cssHeight, measureText, regions);
  drawTranslationText(context, layout, size.cssWidth);
}

async function extractPageImageRegions(pageNumber: number, generation: number): Promise<void> {
  if (generation !== documentGeneration || !pdfDocument || imageRegionsByPage.has(pageNumber) || imageRegionsPending.has(pageNumber)) return;
  imageRegionsPending.add(pageNumber);
  let succeeded = false;
  try {
    const handle = pdfDocument;
    const regions = await handle.extractImageRegions(pageNumber);
    if (generation !== documentGeneration) return;
    imageRegionsByPage.set(pageNumber, regions);
    succeeded = true;
  } catch {
    if (generation === documentGeneration) imageRegionsByPage.set(pageNumber, []);
  } finally {
    imageRegionsPending.delete(pageNumber);
  }
  if (succeeded && generation === documentGeneration) {
    const view = pageViews.get(pageNumber);
    if (view && renderedPages.has(pageNumber)) updateTranslationPage(pageNumber, true);
  }
}

function updateTranslationPage(pageNumber: number, draw = renderedPages.has(pageNumber)): void {
  const view = pageViews.get(pageNumber);
  if (!view) return;
  const state = currentTranslationState(pageNumber);
  const page = extractedPages.get(pageNumber);
  if (state.status === "complete") {
    view.translationHidden.textContent = `第 ${pageNumber} 页译文：${state.text}`;
    view.translationCanvas.setAttribute("aria-label", `第 ${pageNumber} 页译文画布`);
    view.copyButton.textContent = "复制本页译文";
    view.copyButton.setAttribute("aria-label", `复制第 ${pageNumber} 页译文`);
  } else if (state.status === "partial") {
    view.translationHidden.textContent = `第 ${pageNumber} 页部分译文：${state.text || "当前没有可复制译文"}`;
    view.translationCanvas.setAttribute("aria-label", `第 ${pageNumber} 页部分译文画布`);
    view.copyButton.textContent = "复制当前部分译文";
    view.copyButton.setAttribute("aria-label", `复制第 ${pageNumber} 页当前部分译文`);
  } else {
    const noText = page && !page.paragraphs.length;
    view.translationHidden.textContent = noText
      ? `第 ${pageNumber} 页没有可提取文本，暂不支持扫描件 OCR。`
      : `第 ${pageNumber} 页译文等待中。`;
    view.translationCanvas.setAttribute("aria-label", noText ? `第 ${pageNumber} 页无可提取译文` : `第 ${pageNumber} 页译文等待中`);
    view.copyButton.textContent = "复制本页译文";
    view.copyButton.setAttribute("aria-label", `复制第 ${pageNumber} 页译文`);
  }
  view.copyButton.disabled = !state.text;
  if (draw) drawPageTranslation(pageNumber, view, state);
}

async function copyPageTranslation(pageNumber: number): Promise<void> {
  const view = pageViews.get(pageNumber);
  if (!view) return;
  const state = currentTranslationState(pageNumber);
  if (!state.text) return;
  view.copyFeedback.textContent = "";
  try {
    await navigator.clipboard.writeText(state.text);
    view.copyFeedback.textContent = state.status === "partial" ? "已复制当前部分译文。" : "已复制本页译文。";
  } catch {
    view.copyFeedback.textContent = "复制失败，请重试。";
  }
}

async function cancelBackgroundPdfTranslations(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({ type: "CANCEL_PDF_TRANSLATIONS" }) as Response<{ cancelled: boolean }>;
    return response.ok && response.data.cancelled;
  } catch {
    return false;
  }
}

async function disposeDocument(): Promise<number> {
  const generation = ++documentGeneration;
  translationGeneration += 1;
  const previousDocument = pdfDocument;
  let destroyFailed = false;
  const lifecycle = disposeAfterTranslationCancellation({
    queue: translationQueue,
    clearQueueReference: () => { translationQueue = undefined; },
    cancelRemote: cancelBackgroundPdfTranslations,
    destroyDocument: async () => {
      if (!previousDocument) return;
      try { await previousDocument.destroy(); }
      catch { destroyFailed = true; }
    }
  });
  targetResolver.clear();
  abortController?.abort();
  abortController = undefined;
  pdfDocument?.cancelRenderTasks();
  pdfDocument = undefined;
  const translationsCancelled = await lifecycle;
  pageObserver?.disconnect();
  pageObserver = undefined;
  clearResizeScheduling();
  for (const [pageNumber, view] of pageViews) clearPagePair(pageNumber, view);
  documentView.replaceChildren();
  pageViews.clear();
  extractedPages.clear();
  itemsByPage.clear();
  translatedById.clear();
  failedItemIds.clear();
  queuedPages.clear();
  visiblePages.clear();
  renderedPages.clear();
  renderingPages.clear();
  cancelledRenderingPages.clear();
  failedRenderingPages.clear();
  imageRegionsByPage.clear();
  imageRegionsPending.clear();
  serifVotes.length = 0;
  extractionDone = false;
  characterLimitReached = false;
  translationStarted = false;
  usedCharacters = 0;
  totalItems = 0;
  completedItems = 0;
  failedBatches = 0;
  currentTarget = "";
  translateButton.textContent = "开始翻译";
  updateProgress();
  if (destroyFailed && generation === documentGeneration) {
    setStatus("上一份文档已清理", "PDF 关闭过程异常，已清理页面资源并继续加载新来源。");
  } else if (!translationsCancelled && generation === documentGeneration) {
    setStatus("无法取消旧翻译", "请重试加载；在旧请求安全结束前不会启动新的 PDF 翻译。");
  }
  return generation;
}

function createPageRows(pageCount: number, generation: number): void {
  const fragment = document.createDocumentFragment();
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const row = document.createElement("section");
    row.className = "pdf-page-row";
    row.dataset.page = String(pageNumber);
    row.setAttribute("aria-label", `第 ${pageNumber} 页原文与译文`);

    const original = document.createElement("article");
    original.className = "page-pane";
    const originalHeader = document.createElement("header");
    originalHeader.textContent = `第 ${pageNumber} 页 · 原页`;
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "canvas-wrap";
    canvasWrap.dataset.page = String(pageNumber);
    const canvas = document.createElement("canvas");
    clearCanvasBackingStore(canvas);
    const canvasDescription = document.createElement("p");
    const canvasDescriptionId = `pdf-page-${pageNumber}-canvas-description`;
    canvasDescription.id = canvasDescriptionId;
    canvasDescription.className = "sr-only";
    canvasDescription.textContent = `第 ${pageNumber} 页原页将以画布呈现，右侧区域提供对应译文。`;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `PDF 第 ${pageNumber} 页`);
    canvas.setAttribute("aria-describedby", canvasDescriptionId);
    canvasWrap.append(canvas, canvasDescription);
    original.append(originalHeader, canvasWrap);

    const translated = document.createElement("article");
    translated.className = "page-pane";
    const translatedHeader = document.createElement("header");
    const translatedTitle = document.createElement("span");
    translatedTitle.textContent = `第 ${pageNumber} 页 · 译文`;
    const copyButton = document.createElement("button");
    copyButton.className = "page-copy-button";
    copyButton.type = "button";
    copyButton.textContent = "复制本页译文";
    copyButton.disabled = true;
    copyButton.addEventListener("click", () => void copyPageTranslation(pageNumber));
    translatedHeader.append(translatedTitle, copyButton);
    const translationCanvasWrap = document.createElement("div");
    translationCanvasWrap.className = "canvas-wrap translation-canvas-wrap";
    const translationCanvas = document.createElement("canvas");
    clearCanvasBackingStore(translationCanvas);
    const translationHidden = document.createElement("p");
    const translationDescriptionId = `pdf-page-${pageNumber}-translation-description`;
    translationHidden.id = translationDescriptionId;
    translationHidden.hidden = true;
    translationHidden.textContent = `第 ${pageNumber} 页译文等待中。`;
    translationCanvas.setAttribute("role", "img");
    translationCanvas.setAttribute("aria-label", `第 ${pageNumber} 页译文等待中`);
    translationCanvas.setAttribute("aria-describedby", translationDescriptionId);
    const translationOverlay = document.createElement("div");
    translationOverlay.className = "translation-overlay";
    const copyFeedback = document.createElement("span");
    copyFeedback.className = "sr-only";
    copyFeedback.setAttribute("role", "status");
    copyFeedback.setAttribute("aria-live", "polite");
    translationCanvasWrap.append(translationCanvas, translationHidden, translationOverlay);
    translated.append(translatedHeader, translationCanvasWrap, copyFeedback);
    row.append(original, translated);
    fragment.append(row);
    pageViews.set(pageNumber, {
      row,
      canvasWrap,
      canvas,
      canvasDescription,
      translationCanvas,
      translationOverlay,
      translationHidden,
      copyButton,
      copyFeedback,
      lastWidth: 0
    });
  }
  documentView.replaceChildren(fragment);
  createResizeObserver(generation);

  pageObserver = new IntersectionObserver((entries) => {
    if (generation !== documentGeneration) return;
    for (const entry of entries) {
      const pageNumber = Number((entry.target as HTMLElement).dataset.page);
      if (entry.isIntersecting) {
        visiblePages.add(pageNumber);
      } else {
        visiblePages.delete(pageNumber);
      }
    }
    reconcileCanvasRendering(generation);
  }, { rootMargin: "700px 0px", threshold: 0.01 });
  for (const view of pageViews.values()) pageObserver.observe(view.row);
}

async function renderScheduledPage(pageNumber: number, generation: number): Promise<void> {
  const handle = pdfDocument;
  const view = pageViews.get(pageNumber);
  if (!view) {
    renderingPages.delete(pageNumber);
    return;
  }
  if (!handle) {
    clearPagePair(pageNumber, view);
    renderingPages.delete(pageNumber);
    return;
  }
  try {
    const size = await handle.renderPage(pageNumber, view.canvas, availableCanvasWidth(view));
    if (generation !== documentGeneration) {
      clearPagePair(pageNumber, view);
      return;
    }
    renderingPages.delete(pageNumber);
    renderedPages.add(pageNumber);
    view.size = size;
    view.lastWidth = availableCanvasWidth(view);
    setTranslationCanvasSize(view.translationCanvas, size);
    updateTranslationPage(pageNumber, true);
    void extractPageImageRegions(pageNumber, generation);
    resizeObserver?.observe(view.canvasWrap);
    view.canvasDescription.textContent = `第 ${pageNumber} 页原页已在画布中呈现，右侧区域提供对应译文。`;
  } catch {
    const currentFailure = generation === documentGeneration && !cancelledRenderingPages.has(pageNumber);
    stopObservingResize(pageNumber, view);
    view.size = undefined;
    handlePagePairRenderFailure(view.canvas, view.translationCanvas, currentFailure ? () => {
      failedRenderingPages.add(pageNumber);
      view.canvas.setAttribute("aria-label", `PDF 第 ${pageNumber} 页渲染失败`);
      view.canvasDescription.textContent = `第 ${pageNumber} 页原页画布渲染失败，右侧仍会显示可提取文本的对应译文。`;
    } : undefined);
  } finally {
    renderingPages.delete(pageNumber);
    cancelledRenderingPages.delete(pageNumber);
    if (generation === documentGeneration) reconcileCanvasRendering(generation);
  }
}

function reconcileCanvasRendering(generation: number): void {
  const handle = pdfDocument;
  if (!handle || generation !== documentGeneration) return;
  const desired = selectRetainedCanvasPages(
    [...visiblePages],
    handle.pageCount,
    MAX_RENDERED_PAGE_PAIRS,
    [...failedRenderingPages]
  );
  const plan = planCanvasReconciliation(desired, [...renderingPages], [...renderedPages]);
  for (const pageNumber of plan.evict) {
    const view = pageViews.get(pageNumber);
    if (view) clearPagePair(pageNumber, view);
    renderedPages.delete(pageNumber);
  }
  for (const pageNumber of plan.cancel) {
    cancelledRenderingPages.add(pageNumber);
    handle.cancelRenderTask(pageNumber);
  }
  for (const pageNumber of plan.start) {
    renderingPages.add(pageNumber);
    void renderScheduledPage(pageNumber, generation);
  }
}

function clearTranslations(): void {
  itemsByPage.clear();
  translatedById.clear();
  failedItemIds.clear();
  queuedPages.clear();
  serifVotes.length = 0;
  totalItems = 0;
  completedItems = 0;
  failedBatches = 0;
  for (const [pageNumber, view] of pageViews) {
    view.translationOverlay.replaceChildren();
    view.copyFeedback.textContent = "";
    updateTranslationPage(pageNumber);
  }
  updateProgress();
}

function enqueuePage(pageNumber: number): void {
  if (!translationQueue || queuedPages.has(pageNumber)) return;
  const page = extractedPages.get(pageNumber);
  if (!page?.paragraphs.length) return;
  for (const shape of page.paragraphs) serifVotes.push({ serif: shape.serif, chars: shape.charCount });
  const styled = styleParagraphs(page.paragraphs, majoritySerif(serifVotes));
  const items = translationItemsForPage(pageNumber, styled);
  if (!items.length) return;
  queuedPages.add(pageNumber);
  itemsByPage.set(pageNumber, items);
  totalItems += items.length;
  updateTranslationPage(pageNumber);
  translationQueue.enqueue(items);
  updateProgress();
}

function updateTranslationStatus(): void {
  updateProgress();
  if (failedBatches > 0) {
    setStatus("部分完成", "部分段落翻译失败，可在对应页面重试；其他译文已保留。");
  } else if (extractionDone && totalItems > 0 && completedItems >= totalItems) {
    setStatus("翻译完成", characterLimitReached ? "已翻译可提取内容；文档文本达到 500,000 字符上限。" : "原页与译文已按页对齐。");
  } else if (totalItems > 0) {
    setStatus("正在翻译", "已提取页面会持续加入翻译队列。最多同时处理两个批次。");
  }
}

async function restartTranslation(): Promise<void> {
  const generation = ++translationGeneration;
  const activeDocumentGeneration = documentGeneration;
  translationQueue?.cancel();
  translationQueue = undefined;
  clearTranslations();
  const cancelled = await cancelBackgroundPdfTranslations();
  if (generation !== translationGeneration || activeDocumentGeneration !== documentGeneration || !pdfDocument) return;
  if (!cancelled) {
    setStatus("无法取消旧翻译", "请重试；在旧请求安全结束前不会启动新的翻译队列。");
    return;
  }
  const pages = [...extractedPages.values()];
  if (!pages.some(({ paragraphs }) => paragraphs.length)) {
    detectionResult.textContent = "文档尚无可检测文本。";
    translateButton.disabled = true;
    return;
  }

  setStatus("正在检测", targetLanguage.value === "smart" ? "正在为整份文档选择目标语言。" : "正在应用目标语言设置。");
  const decision = await targetResolver.resolve(activeDocumentGeneration, pages, targetLanguage.value);
  if (generation !== translationGeneration || activeDocumentGeneration !== documentGeneration || !pdfDocument) return;
  currentTarget = decision.resolvedTargetLanguage;
  detectionResult.textContent = decision.label;
  sourceLanguage.disabled = false;
  targetLanguage.disabled = false;
  translateButton.disabled = false;

  let settings: Awaited<ReturnType<typeof loadSettings>>;
  try {
    settings = await loadSettings();
  } catch {
    if (generation === translationGeneration) setStatus("无法读取 AI 设置", "请打开设置页检查配置后重试。");
    return;
  }
  if (generation !== translationGeneration || activeDocumentGeneration !== documentGeneration || !pdfDocument) return;
  if (!settings.apiKey || !settings.baseUrl || !settings.model) {
    setStatus("等待 AI 设置", "PDF 原页和文本已就绪。配置 API Key 后点击“开始翻译”。");
    return;
  }

  translationQueue = new TranslationQueue({
    generation,
    isCurrent: (value) => value === translationGeneration,
    send: async (items) => {
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        items,
        sourceLanguage: sourceLanguage.value,
        targetLanguage: currentTarget
      }) as Response<TranslationResult[]>;
      if (!response.ok) throw new Error("翻译请求失败。");
      return response.data;
    },
    onResults: (items, results) => {
      const affectedPages = new Set<number>();
      for (const item of items) {
        const text = results.get(item.id);
        if (text === undefined) continue;
        if (!translatedById.has(item.id)) completedItems += 1;
        translatedById.set(item.id, text);
        affectedPages.add(item.pageNumber);
      }
      for (const pageNumber of affectedPages) updateTranslationPage(pageNumber);
      updateTranslationStatus();
    },
    onFailure: (items, retry) => {
      failedBatches += 1;
      for (const { id } of items) failedItemIds.add(id);
      const affectedPages = new Set(items.map(({ pageNumber }) => pageNumber));
      const cards: HTMLElement[] = [];
      let handled = false;
      for (const pageNumber of affectedPages) {
        const view = pageViews.get(pageNumber);
        if (!view) continue;
        const card = document.createElement("div");
        card.className = "translation-error-card";
        const message = document.createElement("p");
        message.className = "page-error";
        message.setAttribute("role", "status");
        message.setAttribute("aria-live", "polite");
        message.textContent = `第 ${pageNumber} 页部分内容翻译失败。`;
        const button = document.createElement("button");
        button.className = "retry-button";
        button.type = "button";
        button.textContent = "重试此批次";
        button.setAttribute("aria-label", `重试第 ${pageNumber} 页翻译批次`);
        button.addEventListener("click", () => {
          if (handled) return;
          handled = true;
          for (const { id } of items) failedItemIds.delete(id);
          for (const candidate of cards) candidate.remove();
          for (const affectedPage of affectedPages) updateTranslationPage(affectedPage);
          failedBatches = Math.max(0, failedBatches - 1);
          retry();
          updateTranslationStatus();
        });
        card.append(message, button);
        cards.push(card);
        view.translationOverlay.append(card);
      }
      for (const pageNumber of affectedPages) updateTranslationPage(pageNumber);
      if (!cards.length) {
        for (const { id } of items) failedItemIds.delete(id);
        failedBatches = Math.max(0, failedBatches - 1);
      }
      updateTranslationStatus();
    },
    onIdle: updateTranslationStatus
  });
  translateButton.textContent = "重新翻译";
  for (const page of pages) enqueuePage(page.pageNumber);
  updateTranslationStatus();
}

async function extractDocument(generation: number): Promise<void> {
  const handle = pdfDocument;
  if (!handle) return;
  sourceLanguage.disabled = true;
  targetLanguage.disabled = true;
  translateButton.disabled = true;
  setStatus("正在提取", "正在按页读取文本；扫描页不会发送翻译请求。");
  let nonEmptyPages = 0;

  for (let pageNumber = 1; pageNumber <= handle.pageCount; pageNumber += 1) {
    let paragraphs: ParagraphShape[];
    try {
      paragraphs = await handle.extractPage(pageNumber);
    } catch {
      paragraphs = [];
    }
    if (generation !== documentGeneration) return;
    const limited = applyCharacterLimit(paragraphs, usedCharacters);
    usedCharacters = limited.usedCharacters;
    characterLimitReached ||= limited.limitReached;
    const page = { pageNumber, paragraphs: limited.paragraphs };
    extractedPages.set(pageNumber, page);
    updateTranslationPage(pageNumber);
    if (page.paragraphs.length) nonEmptyPages += 1;
    updateProgress();

    if (!translationStarted && nonEmptyPages >= MAX_DETECTION_PAGES) {
      translationStarted = true;
      await restartTranslation();
      if (generation !== documentGeneration) return;
    } else if (translationQueue) {
      enqueuePage(pageNumber);
    }
    if (characterLimitReached) break;
  }

  if (generation !== documentGeneration) return;
  extractionDone = true;
  if (!translationStarted && extractedPages.size > 0) {
    translationStarted = true;
    await restartTranslation();
  }
  if (generation !== documentGeneration) return;
  sourceLanguage.disabled = false;
  targetLanguage.disabled = false;
  const hasText = [...extractedPages.values()].some(({ paragraphs }) => paragraphs.length);
  if (characterLimitReached) {
    for (let pageNumber = extractedPages.size + 1; pageNumber <= handle.pageCount; pageNumber += 1) {
      const view = pageViews.get(pageNumber);
      if (view) {
        view.translationHidden.textContent = `第 ${pageNumber} 页达到 500,000 字符上限后未提取。`;
        view.translationCanvas.setAttribute("aria-label", `第 ${pageNumber} 页译文未提取`);
        view.copyButton.disabled = true;
        if (view.size) {
          const context = setTranslationCanvasSize(view.translationCanvas, view.size);
          if (context) drawTranslationPlaceholder(context, view.size, "达到文本上限，该页未提取");
        }
      }
    }
  }
  if (!hasText) {
    setStatus("没有可提取文本", "整份文档没有文本层，暂不支持扫描件 OCR。");
    detectionResult.textContent = "未检测到可用于语言判断的文本。";
    translateButton.disabled = true;
  } else {
    translateButton.disabled = false;
    updateTranslationStatus();
    if (characterLimitReached && !translationQueue && totalItems === 0) {
      setStatus("已达到文本上限", "已停止提取后续页面。配置 AI 后可翻译已提取的 500,000 字符。");
    }
  }
}

async function loadDocument(loadBytes: (signal: AbortSignal) => Promise<Uint8Array>): Promise<void> {
  setLoadingControls(true);
  const generation = await disposeDocument();
  if (generation !== documentGeneration) return;
  const controller = new AbortController();
  abortController = controller;
  setStatus("正在加载", "正在安全读取 PDF，网络重定向将被拒绝。");
  detectionResult.textContent = "等待文档文本检测。";
  try {
    const bytes = await loadBytes(controller.signal);
    if (generation !== documentGeneration) return;
    const handle = await PdfDocumentHandle.open(bytes);
    if (generation !== documentGeneration) {
      handle.cancelRenderTasks();
      await handle.destroy();
      return;
    }
    pdfDocument = handle;
    createPageRows(handle.pageCount, generation);
    setStatus("文档已加载", `共 ${handle.pageCount} 页，正在准备原页与文本。`);
    updateProgress();
    void extractDocument(generation);
  } catch {
    if (generation !== documentGeneration) return;
    setStatus(controller.signal.aborted ? "加载已取消" : "无法加载 PDF", controller.signal.aborted
      ? "已取消当前文档处理。"
      : "请检查文件格式、50 MiB/300 页限制、来源权限或网络状态后重试。不会显示来源查询参数。"
    );
  } finally {
    if (generation === documentGeneration) setLoadingControls(false);
  }
}

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  urlLoadButton.click();
});

urlLoadButton.addEventListener("click", async () => {
  const actionGeneration = ++sourceActionGeneration;
  let source: URL;
  try {
    source = parsePdfSourceUrl(urlInput.value.trim());
  } catch {
    setStatus("网址无效", "请输入 HTTP、HTTPS 或已授权的 file PDF 地址。");
    urlInput.focus();
    return;
  }

  const permission = pdfSourcePermissionPattern(source);
  try {
    if (permission) {
      const granted = await chrome.permissions.request({ origins: [permission] });
      if (actionGeneration !== sourceActionGeneration) return;
      if (!granted) {
        setStatus("权限被拒绝", "未授予来源站点权限。输入已保留，可再次点击加载并授权。");
        return;
      }
    } else if (!await chrome.extension.isAllowedFileSchemeAccess()) {
      if (actionGeneration !== sourceActionGeneration) return;
      setStatus("无法读取 file 地址", "请在扩展管理页允许访问文件网址，或使用本地 PDF 选择器。");
      return;
    }

    const response = await chrome.runtime.sendMessage({ type: "SET_PDF_SOURCE", sourceUrl: source.href }) as Response<PdfSourceResponse>;
    if (actionGeneration !== sourceActionGeneration) return;
    if (!response.ok) {
      setStatus("无法保存来源", "来源权限可能已变化，请重新授权后重试。");
      return;
    }
    await loadDocument((signal) => loadPdfFromUrl(source, signal));
  } catch {
    if (actionGeneration === sourceActionGeneration) setStatus("无法访问来源", "请检查来源权限或网络状态后重试。");
  }
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const actionGeneration = ++sourceActionGeneration;
  try {
    const cleared = await chrome.runtime.sendMessage({ type: "CLEAR_PDF_SOURCE" }) as Response<PdfSourceResponse>;
    if (!cleared.ok) throw new Error("无法清除旧来源。");
  } catch {
    if (actionGeneration === sourceActionGeneration) {
      setStatus("正在打开本地文件", "旧来源记录无法清除；本地文件仍不会写入会话。");
    }
  }
  if (actionGeneration === sourceActionGeneration) await loadDocument(() => loadPdfFromFile(file));
  fileInput.value = "";
});

sourceLanguage.addEventListener("change", () => { if (pdfDocument) void restartTranslation(); });
targetLanguage.addEventListener("change", () => { if (pdfDocument) void restartTranslation(); });
translateButton.addEventListener("click", () => { if (pdfDocument) void restartTranslation(); });
element<HTMLButtonElement>("settings-button").addEventListener("click", () => void chrome.runtime.openOptionsPage());

window.addEventListener("beforeunload", () => {
  documentGeneration += 1;
  translationGeneration += 1;
  cancelAndClearTranslationQueue(translationQueue, () => { translationQueue = undefined; });
  void cancelBackgroundPdfTranslations();
  targetResolver.clear();
  abortController?.abort();
  pdfDocument?.cancelRenderTasks();
  pdfDocument = undefined;
  imageRegionsByPage.clear();
  imageRegionsPending.clear();
  pageObserver?.disconnect();
  clearResizeScheduling();
  for (const [pageNumber, view] of pageViews) clearPagePair(pageNumber, view);
});

async function initialize(): Promise<void> {
  const actionGeneration = sourceActionGeneration;
  const settings = await loadSettings();
  if (actionGeneration !== sourceActionGeneration) return;
  if (Array.from(sourceLanguage.options).some(({ value }) => value === settings.sourceLanguage)) sourceLanguage.value = settings.sourceLanguage;
  targetLanguage.value = "smart";
  const response = await chrome.runtime.sendMessage({ type: "GET_PDF_SOURCE" }) as Response<PdfSourceResponse>;
  if (actionGeneration !== sourceActionGeneration) return;
  if (!response.ok || !response.data.source) {
    setStatus("来源缺失或已过期", "请输入 PDF 网址或选择本地 PDF 文件。");
    return;
  }
  let source: URL;
  try {
    source = parsePdfSourceUrl(response.data.source.sourceUrl);
  } catch {
    setStatus("来源已失效", "保存的 PDF 来源无效，请重新选择。");
    return;
  }
  if (source.protocol === "file:") {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess();
    if (actionGeneration !== sourceActionGeneration) return;
    if (!allowed) {
      setStatus("文件访问未授权", "请允许扩展访问文件网址，或使用本地 PDF 选择器。");
      return;
    }
  }
  await loadDocument((signal) => loadPdfFromUrl(source, signal));
}

void initialize().catch(() => {
  if (sourceActionGeneration === 0) setStatus("初始化失败", "无法恢复 PDF 来源，请重新选择。");
});
