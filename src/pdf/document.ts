import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { resolveTargetLanguage, type LanguageDetector, type TargetLanguageDecision } from "../shared/language";
import { classifyFontFamily, type SerifKind } from "./font-classify";
import { reconstructParagraphShapes, type ParagraphShape } from "./text";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const MAX_PDF_PAGES = 300;
export const MAX_EXTRACTED_CHARACTERS = 500_000;
export const MAX_DETECTION_PAGES = 3;
export const MAX_DETECTION_CHARACTERS = 4000;
export const MAX_RENDERED_PAGE_PAIRS = 4;
export const MAX_NONZERO_CANVASES = 8;
export const MAX_RENDERED_CANVASES = MAX_RENDERED_PAGE_PAIRS;
export const MAX_IMAGE_REGIONS_PER_PAGE = 60;
export const MAX_IMAGE_OPERATOR_LIST = 50_000;

export interface PageImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageCanvasSize {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  dpr: number;
}

export interface ExtractedPage {
  pageNumber: number;
  paragraphs: ParagraphShape[];
}

export interface CharacterLimitResult {
  paragraphs: ParagraphShape[];
  usedCharacters: number;
  limitReached: boolean;
}

export interface CanvasReconciliationPlan {
  cancel: number[];
  evict: number[];
  start: number[];
}

export function createPageCanvasSize(cssWidth: number, cssHeight: number, devicePixelRatio: number): PageCanvasSize {
  const dpr = Math.min(Math.max(devicePixelRatio || 1, 1), 2);
  return {
    cssWidth: Math.ceil(cssWidth),
    cssHeight: Math.ceil(cssHeight),
    backingWidth: Math.ceil(cssWidth * dpr),
    backingHeight: Math.ceil(cssHeight * dpr),
    dpr
  };
}

export class DocumentTargetResolver {
  private documentGeneration: number | undefined;
  private smartDecision: Promise<TargetLanguageDecision> | undefined;

  constructor(private readonly detector?: LanguageDetector) {}

  resolve(
    documentGeneration: number,
    pages: readonly ExtractedPage[],
    targetLanguage: string
  ): Promise<TargetLanguageDecision> {
    if (this.documentGeneration !== documentGeneration) {
      this.documentGeneration = documentGeneration;
      this.smartDecision = undefined;
    }
    if (targetLanguage !== "smart") {
      return resolveTargetLanguage(collectDetectionSample(pages), targetLanguage, this.detector);
    }
    this.smartDecision ??= resolveTargetLanguage(collectDetectionSample(pages), "smart", this.detector);
    return this.smartDecision;
  }

  clear(): void {
    this.documentGeneration = undefined;
    this.smartDecision = undefined;
  }
}

export function assertPdfPageLimit(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_PAGES) {
    throw new Error(`PDF 页数必须在 1 到 ${MAX_PDF_PAGES} 页之间。`);
  }
}

export function applyCharacterLimit(
  paragraphs: readonly ParagraphShape[],
  usedCharacters: number,
  maximum = MAX_EXTRACTED_CHARACTERS
): CharacterLimitResult {
  let used = usedCharacters;
  const accepted: ParagraphShape[] = [];
  for (const paragraph of paragraphs) {
    const remaining = maximum - used;
    if (remaining <= 0) return { paragraphs: accepted, usedCharacters: used, limitReached: true };
    if (paragraph.text.length > remaining) {
      accepted.push({ ...paragraph, text: paragraph.text.slice(0, remaining) });
      return { paragraphs: accepted, usedCharacters: maximum, limitReached: true };
    }
    accepted.push(paragraph);
    used += paragraph.text.length;
  }
  return { paragraphs: accepted, usedCharacters: used, limitReached: used >= maximum };
}

export function collectDetectionSample(pages: readonly ExtractedPage[]): string {
  let sample = "";
  let pageCount = 0;
  for (const page of [...pages].sort((left, right) => left.pageNumber - right.pageNumber)) {
    const text = page.paragraphs.map((paragraph) => paragraph.text).join("\n\n").trim();
    if (!text) continue;
    const separator = sample ? "\n\n" : "";
    const remaining = MAX_DETECTION_CHARACTERS - sample.length;
    if (remaining <= separator.length) break;
    sample += separator + text.slice(0, remaining - separator.length);
    pageCount += 1;
    if (pageCount >= MAX_DETECTION_PAGES || sample.length >= MAX_DETECTION_CHARACTERS) break;
  }
  return sample.slice(0, MAX_DETECTION_CHARACTERS);
}

export async function resolveDocumentTarget(
  pages: readonly ExtractedPage[],
  targetLanguage: string,
  detector?: LanguageDetector
): Promise<TargetLanguageDecision> {
  return resolveTargetLanguage(collectDetectionSample(pages), targetLanguage, detector);
}

export function selectRetainedCanvasPages(
  visiblePages: readonly number[],
  pageCount: number,
  maximum = MAX_RENDERED_CANVASES,
  excludedPages: readonly number[] = []
): number[] {
  const visible = [...new Set(visiblePages.filter((page) => page >= 1 && page <= pageCount))].sort((a, b) => a - b);
  const excluded = new Set(excludedPages);
  if (!visible.length || maximum <= 0) return [];
  return Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((page) => !excluded.has(page))
    .sort((left, right) => {
      const leftDistance = Math.min(...visible.map((page) => Math.abs(page - left)));
      const rightDistance = Math.min(...visible.map((page) => Math.abs(page - right)));
      return leftDistance - rightDistance || left - right;
    })
    .slice(0, maximum)
    .sort((a, b) => a - b);
}

export function planCanvasReconciliation(
  desiredPages: readonly number[],
  renderingPages: readonly number[],
  renderedPages: readonly number[],
  maximum = MAX_RENDERED_CANVASES
): CanvasReconciliationPlan {
  const desired = [...new Set(desiredPages)].slice(0, Math.max(0, maximum));
  const desiredSet = new Set(desired);
  const rendering = new Set(renderingPages);
  const rendered = new Set(renderedPages);
  const cancel = [...rendering].filter((page) => !desiredSet.has(page)).sort((a, b) => a - b);
  const evict = [...rendered].filter((page) => !desiredSet.has(page)).sort((a, b) => a - b);
  const retainedRendered = [...rendered].filter((page) => desiredSet.has(page)).length;
  const available = Math.max(0, maximum - rendering.size - retainedRendered);
  const start = desired
    .filter((page) => !rendering.has(page) && !rendered.has(page))
    .slice(0, available);
  return { cancel, evict, start };
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 1, 0, 0];
const UNIT_CORNERS: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [0, 1], [1, 1]];

function multiplyMatrix(left: Matrix, right: Matrix): Matrix {
  const [a, b, c, d, e, f] = pdfjsLib.Util.transform(left, right);
  return [a, b, c, d, e, f];
}

function imageRegionFromMatrix(
  matrix: readonly number[],
  viewport: { width: number; height: number; transform: readonly number[] }
): PageImageRegion {
  const m = matrix as Matrix;
  const t = viewport.transform as Matrix;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [u, v] of UNIT_CORNERS) {
    const userX = m[0] * u + m[2] * v + m[4];
    const userY = m[1] * u + m[3] * v + m[5];
    const x = t[0] * userX + t[2] * userY + t[4];
    const y = t[1] * userX + t[3] * userY + t[5];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    x: minX / viewport.width,
    y: minY / viewport.height,
    width: (maxX - minX) / viewport.width,
    height: (maxY - minY) / viewport.height
  };
}

export function extractImageRegionsFromOperatorList(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  viewport: { width: number; height: number; transform: readonly number[] }
): PageImageRegion[] {
  if (fnArray.length > MAX_IMAGE_OPERATOR_LIST) return [];
  const ops = pdfjsLib.OPS;
  let ctm: Matrix = IDENTITY_MATRIX;
  const stack: Matrix[] = [];
  const regions: PageImageRegion[] = [];
  for (let index = 0; index < fnArray.length; index += 1) {
    const op = fnArray[index];
    const args = argsArray[index];
    if (op === ops.transform) {
      ctm = multiplyMatrix(ctm, args as Matrix);
    } else if (op === ops.save) {
      stack.push(ctm);
    } else if (op === ops.restore) {
      const restored = stack.pop();
      if (restored) ctm = restored;
    } else if (op === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = (args as readonly unknown[] | null | undefined)?.[0] as Matrix | undefined;
      if (matrix) ctm = multiplyMatrix(ctm, matrix);
    } else if (op === ops.paintFormXObjectEnd) {
      const restored = stack.pop();
      if (restored) ctm = restored;
    } else if (op === ops.beginGroup) {
      stack.push(ctm);
      const group = (args as readonly unknown[] | null | undefined)?.[0] as { matrix?: readonly number[] } | undefined;
      if (group?.matrix) ctm = multiplyMatrix(ctm, group.matrix as Matrix);
    } else if (op === ops.endGroup) {
      const restored = stack.pop();
      if (restored) ctm = restored;
    } else if (op === ops.paintImageXObject || op === ops.paintInlineImageXObject) {
      regions.push(imageRegionFromMatrix(ctm, viewport));
    }
  }
  return regions
    .filter((region) => region.width > 0.004 && region.height > 0.004)
    .filter((region) => !(region.width >= 0.9 && region.height >= 0.9))
    .sort((left, right) => right.width * right.height - left.width * left.height)
    .slice(0, MAX_IMAGE_REGIONS_PER_PAGE);
}

class PdfRenderCancelledError extends Error {}

export class PdfDocumentHandle {
  private readonly renderTasks = new Map<number, RenderTask>();
  private readonly cancelledRenderPages = new Set<number>();

  private constructor(private readonly pdf: PDFDocumentProxy) {}

  static async open(data: Uint8Array): Promise<PdfDocumentHandle> {
    const loadingTask = pdfjsLib.getDocument({ data, isEvalSupported: false });
    const pdf = await loadingTask.promise;
    try {
      assertPdfPageLimit(pdf.numPages);
      return new PdfDocumentHandle(pdf);
    } catch (error) {
      await pdf.destroy();
      throw error;
    }
  }

  get pageCount(): number {
    return this.pdf.numPages;
  }

  async extractPage(pageNumber: number): Promise<ParagraphShape[]> {
    const page = await this.pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const serifByFont = new Map<string, SerifKind | undefined>();
    const resolveSerif = (fontName?: string): SerifKind | undefined => {
      if (!fontName) return undefined;
      if (serifByFont.has(fontName)) return serifByFont.get(fontName);
      const kind = classifyFontFamily(content.styles[fontName]?.fontFamily);
      serifByFont.set(fontName, kind);
      return kind;
    };
    const items = content.items.flatMap((item) => "str" in item ? [{
      str: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
      hasEOL: item.hasEOL,
      fontName: item.fontName
    }] : []);
    const viewport = page.getViewport({ scale: 1 });
    const isUnsafeFont = (fontName?: string): boolean => {
      if (!fontName) return false;
      return content.styles[fontName]?.vertical === true;
    };
    return reconstructParagraphShapes(items, resolveSerif, { viewport, isUnsafeFont });
  }

  async extractImageRegions(pageNumber: number): Promise<PageImageRegion[]> {
    const page = await this.pdf.getPage(pageNumber);
    const operatorList = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1 });
    return extractImageRegionsFromOperatorList(operatorList.fnArray, operatorList.argsArray, viewport);
  }

  async renderPage(pageNumber: number, canvas: HTMLCanvasElement, availableWidth: number): Promise<PageCanvasSize> {
    this.cancelledRenderPages.delete(pageNumber);
    const page = await this.pdf.getPage(pageNumber);
    if (this.cancelledRenderPages.has(pageNumber)) throw new PdfRenderCancelledError();
    const base = page.getViewport({ scale: 1 });
    const cssScale = Math.max(0.1, availableWidth / base.width);
    const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const cssViewport = page.getViewport({ scale: cssScale });
    const viewport = page.getViewport({ scale: cssScale * pixelRatio });
    const size = createPageCanvasSize(cssViewport.width, cssViewport.height, pixelRatio);
    canvas.width = size.backingWidth;
    canvas.height = size.backingHeight;
    canvas.style.width = `${size.cssWidth}px`;
    canvas.style.height = `${size.cssHeight}px`;
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) throw new Error("无法创建 PDF 画布。");
    const task = page.render({ canvasContext, viewport });
    this.renderTasks.set(pageNumber, task);
    try {
      await task.promise;
    } catch (error) {
      if (this.cancelledRenderPages.has(pageNumber)) throw new PdfRenderCancelledError();
      throw error;
    } finally {
      if (this.renderTasks.get(pageNumber) === task) this.renderTasks.delete(pageNumber);
      this.cancelledRenderPages.delete(pageNumber);
    }
    return size;
  }

  cancelRenderTask(pageNumber: number): void {
    this.cancelledRenderPages.add(pageNumber);
    this.renderTasks.get(pageNumber)?.cancel();
  }

  cancelRenderTasks(): void {
    for (const [pageNumber, task] of this.renderTasks) {
      this.cancelledRenderPages.add(pageNumber);
      task.cancel();
    }
  }

  async destroy(): Promise<void> {
    await this.pdf.destroy();
  }
}
