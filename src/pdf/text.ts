import { majoritySerif, weightedMedian } from "./font-classify";
import type { SerifKind } from "./style";

export interface PdfTextItem {
  str: string;
  transform: ArrayLike<number>;
  width: number;
  height: number;
  hasEOL: boolean;
  fontName?: string;
}

export interface ParagraphShape {
  text: string;
  fontSize: number;
  charCount: number;
  lineCount: number;
  serif: SerifKind | undefined;
  topY?: number;
  bottomY?: number;
  fontSizeRatio?: number;
  centered?: boolean;
}

interface TextLine {
  text: string;
  x: number;
  y: number;
  height: number;
  endX: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  serifWeight: number;
  sansWeight: number;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
const CJK_START = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const NO_SPACE_BEFORE = /^[,.;:!?，。；：！？、)\]}]/u;

function appendText(current: string, next: string, gap: number, height: number): string {
  if (!current || /^\s/u.test(next) || /\s$/u.test(current) || NO_SPACE_BEFORE.test(next)) return current + next;
  if (CJK.test(current) && CJK_START.test(next)) return current + next;
  return gap > Math.max(1, height * 0.12) ? `${current} ${next}` : current + next;
}

function joinLines(current: string, next: string): string {
  if (/\p{Letter}-$/u.test(current) && /^\p{Lowercase_Letter}/u.test(next)) return current.slice(0, -1) + next;
  if (CJK.test(current) && CJK_START.test(next)) return current + next;
  return `${current} ${next}`;
}

function buildLines(
  items: readonly PdfTextItem[],
  resolveSerif: (fontName?: string) => SerifKind | undefined
): TextLine[] {
  const lines: TextLine[] = [];
  let current: TextLine | undefined;
  let forcedLineBreak = false;

  for (const item of items) {
    const text = item.str.replace(/\s+/gu, " ");
    if (!text.trim()) {
      if (item.hasEOL) forcedLineBreak = true;
      continue;
    }
    const x = Number(item.transform[4] ?? 0);
    const y = Number(item.transform[5] ?? 0);
    const height = Math.max(1, Math.abs(item.height || Number(item.transform[3] ?? 0)));
    const boxWidth = item.width;
    const boxHeight = item.height;
    const minX = Math.min(x, x + boxWidth);
    const maxX = Math.max(x, x + boxWidth);
    const minY = Math.min(y, y + boxHeight);
    const maxY = Math.max(y, y + boxHeight);
    const serif = resolveSerif(item.fontName);
    const serifWeight = serif === "serif" ? item.str.length : 0;
    const sansWeight = serif === "sans" ? item.str.length : 0;
    const startsLine = !current
      || forcedLineBreak
      || Math.abs(y - current.y) > Math.max(2, height * 0.45)
      || x < current.endX - Math.max(2, height * 0.3);

    if (startsLine) {
      current = {
        text: text.trim(), x, y, height, endX: x + item.width,
        minX, maxX, minY, maxY, serifWeight, sansWeight
      };
      lines.push(current);
    } else {
      const line = current;
      if (!line) continue;
      line.text = appendText(line.text, text, x - line.endX, height);
      line.endX = Math.max(line.endX, x + item.width);
      line.height = Math.max(line.height, height);
      line.minX = Math.min(line.minX, minX);
      line.maxX = Math.max(line.maxX, maxX);
      line.minY = Math.min(line.minY, minY);
      line.maxY = Math.max(line.maxY, maxY);
      line.serifWeight += serifWeight;
      line.sansWeight += sansWeight;
    }
    forcedLineBreak = item.hasEOL;
  }
  return lines;
}

function paragraphGroups(lines: readonly TextLine[]): TextLine[][] {
  const groups: TextLine[][] = [];
  let group: TextLine[] = [];
  let previous: TextLine | undefined;
  for (const line of lines) {
    const verticalGap = previous ? previous.y - line.y : 0;
    const newColumn = previous ? line.y > previous.y + Math.max(previous.height, line.height) : false;
    const paragraphBreak = previous
      ? newColumn || verticalGap > Math.max(previous.height, line.height) * 1.8
      : false;
    if (paragraphBreak && group.length) {
      groups.push(group);
      group = [];
    }
    group.push(line);
    previous = line;
  }
  if (group.length) groups.push(group);
  return groups;
}

function joinParagraph(lines: readonly TextLine[]): string {
  let paragraph = "";
  for (const line of lines) {
    paragraph = paragraph ? joinLines(paragraph, line.text) : line.text;
  }
  return paragraph.trim();
}

function lineSerif(line: TextLine): SerifKind | undefined {
  if (line.serifWeight === line.sansWeight) return undefined;
  return line.serifWeight > line.sansWeight ? "serif" : "sans";
}

export interface ParagraphGeometry {
  viewport: { width: number; height: number; transform: readonly number[] };
  isUnsafeFont?: (fontName?: string) => boolean;
}

function finiteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function transformY(transform: readonly number[], x: number, y: number): number {
  return (transform[1] ?? 0) * x + (transform[3] ?? 0) * y + (transform[5] ?? 0);
}

function validateGeometry(items: readonly PdfTextItem[], geometry: ParagraphGeometry): number | undefined {
  const { viewport, isUnsafeFont } = geometry;
  if (!finiteNumber(viewport.width) || viewport.width <= 0) return undefined;
  if (!finiteNumber(viewport.height) || viewport.height <= 0) return undefined;
  const t = viewport.transform;
  if (t.length < 6) return undefined;
  const t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3], t4 = t[4], t5 = t[5];
  if (!finiteNumber(t0) || !finiteNumber(t1) || !finiteNumber(t2) || !finiteNumber(t3) || !finiteNumber(t4) || !finiteNumber(t5)) {
    return undefined;
  }
  const u = Math.hypot(t0, t1);
  const v = Math.hypot(t2, t3);
  if (!Number.isFinite(u) || u <= 0 || !Number.isFinite(v) || v <= 0) return undefined;
  if (Math.abs(u - v) / Math.max(u, v) > 1e-6) return undefined;

  for (const item of items) {
    if (!item.str.trim()) continue;
    if (isUnsafeFont?.(item.fontName)) return undefined;
    const a = Number(item.transform[0] ?? 0);
    const b = Number(item.transform[1] ?? 0);
    const c = Number(item.transform[2] ?? 0);
    const d = Number(item.transform[3] ?? 0);
    const sx = Math.hypot(a, b);
    const sy = Math.hypot(c, d);
    if (!Number.isFinite(sx) || sx <= 0 || !Number.isFinite(sy) || sy <= 0) return undefined;
    if (!(a > 0) || !(d > 0)) return undefined;
    if (Math.abs(b) / sx > 1e-3) return undefined;
    if (Math.abs(c) / sy > 1e-3) return undefined;
    if (Math.abs(a * c + b * d) / (sx * sy) > 1e-3) return undefined;
  }
  return u;
}

function paragraphAnchor(
  lines: readonly TextLine[],
  fontSize: number,
  u: number,
  viewport: { width: number; height: number; transform: readonly number[] }
): { topY: number; bottomY: number; fontSizeRatio: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    minX = Math.min(minX, line.minX);
    maxX = Math.max(maxX, line.maxX);
    minY = Math.min(minY, line.minY);
    maxY = Math.max(maxY, line.maxY);
  }
  const mappedY = [
    transformY(viewport.transform, minX, minY),
    transformY(viewport.transform, maxX, minY),
    transformY(viewport.transform, minX, maxY),
    transformY(viewport.transform, maxX, maxY)
  ];
  const minMapped = Math.min(...mappedY);
  const maxMapped = Math.max(...mappedY);
  const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
  return {
    topY: clamp01(minMapped / viewport.height),
    bottomY: clamp01(maxMapped / viewport.height),
    fontSizeRatio: (fontSize * u) / viewport.height
  };
}

function transformX(transform: readonly number[], x: number, y: number): number {
  return (transform[0] ?? 0) * x + (transform[2] ?? 0) * y + (transform[4] ?? 0);
}

function centeredViewport(viewport: { width: number; height: number; transform: readonly number[] }): boolean {
  const t = viewport.transform;
  if (t.length < 6) return false;
  const t0 = t[0], t1 = t[1], t2 = t[2], t3 = t[3];
  if (!finiteNumber(t0) || !finiteNumber(t1) || !finiteNumber(t2) || !finiteNumber(t3)) return false;
  const u = Math.hypot(t0, t1);
  const v = Math.hypot(t2, t3);
  if (!Number.isFinite(u) || u <= 0 || !Number.isFinite(v) || v <= 0) return false;
  if (Math.abs(t1) / u > 1e-3) return false;
  if (Math.abs(t2) / v > 1e-3) return false;
  if (!(t0 > 0)) return false;
  return true;
}

function paragraphCentered(
  lines: readonly TextLine[],
  viewport: { width: number; height: number; transform: readonly number[] }
): boolean {
  const width = viewport.width;
  let maxWidth = -Infinity;
  let maxLeft = -Infinity;
  let minLeft = Infinity;
  for (const line of lines) {
    const t = viewport.transform;
    const xs = [
      transformX(t, line.minX, line.minY),
      transformX(t, line.maxX, line.minY),
      transformX(t, line.minX, line.maxY),
      transformX(t, line.maxX, line.maxY)
    ];
    let left = Infinity;
    let right = -Infinity;
    for (const x of xs) {
      if (!Number.isFinite(x)) return false;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
    const offset = Math.abs((left + right) / 2 - width / 2) / width;
    if (offset > 0.015) return false;
    maxWidth = Math.max(maxWidth, right - left);
    maxLeft = Math.max(maxLeft, left);
    minLeft = Math.min(minLeft, left);
  }
  if (maxWidth / width <= 0.75) return true;
  if (lines.length >= 2 && (maxLeft - minLeft) / width >= 0.02) return true;
  return false;
}

export function reconstructParagraphShapes(
  items: readonly PdfTextItem[],
  resolveSerif: (fontName?: string) => SerifKind | undefined,
  geometry?: ParagraphGeometry
): ParagraphShape[] {
  const safeU = geometry ? validateGeometry(items, geometry) : undefined;
  const centerEligible = safeU !== undefined && centeredViewport(geometry!.viewport);
  const shapes: ParagraphShape[] = [];
  for (const lines of paragraphGroups(buildLines(items, resolveSerif))) {
    const text = joinParagraph(lines);
    if (!text) continue;
    const fontSize = weightedMedian(lines.map((line) => ({ value: line.height, weight: line.text.length })));
    const serif = majoritySerif(lines.map((line) => ({ serif: lineSerif(line), chars: line.text.length })));
    const shape: ParagraphShape = { text, fontSize, charCount: text.length, lineCount: lines.length, serif };
    if (safeU !== undefined) {
      const anchor = paragraphAnchor(lines, fontSize, safeU, geometry!.viewport);
      shape.topY = anchor.topY;
      shape.bottomY = anchor.bottomY;
      shape.fontSizeRatio = anchor.fontSizeRatio;
    }
    if (centerEligible && paragraphCentered(lines, geometry!.viewport)) {
      shape.centered = true;
    }
    shapes.push(shape);
  }
  return shapes;
}
