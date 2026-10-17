import { MONOSPACE_STACK, serifStack, type SerifKind } from "./font-classify";
import { headingFontSize, type StyledParagraph } from "./style";
import type { PageImageRegion } from "./document";

export type TranslationRunKind = "text" | "code";

export interface TranslationLayoutRun {
  text: string;
  kind: TranslationRunKind;
  width: number;
}

export interface TranslationLayoutLine {
  runs: TranslationLayoutRun[];
  width: number;
  y: number;
  paragraphEnd: boolean;
  fontSize: number;
  serif: SerifKind;
  weight: 400 | 700;
  x?: number;
}

export interface TranslationLayout {
  fontSize: number;
  lineHeight: number;
  paragraphGap: number;
  padding: number;
  footerHeight: number;
  footerY: number;
  bodyBottom: number;
  lines: TranslationLayoutLine[];
  overflow: boolean;
  footerText?: string;
}

export type TranslationTextMeasurer = (text: string, fontSize: number, kind: TranslationRunKind, serif: SerifKind, weight: 400 | 700) => number;

export interface ExclusionBand {
  top: number;
  bottom: number;
}

export function fontString(serif: SerifKind, kind: TranslationRunKind, size: number, weight: 400 | 700 = 400): string {
  const bold = weight === 700 ? "bold " : "";
  return kind === "code"
    ? `${bold}${size}px ${MONOSPACE_STACK}`
    : `${bold}${size}px ${serifStack(serif)}`;
}

export const TRANSLATION_OVERFLOW_FOOTER = "译文过长，完整内容请复制";
export const TRANSLATION_FOOTER_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
const MIN_FONT_SIZE = 12;
const ANCHOR_MAX_FONT_SIZE = 24;
const ANCHOR_MIN_FONT_SIZE = 8;
const ANCHOR_DESIRED_MIN_FONT_SIZE = 10;
const LINE_HEIGHT_RATIO = 1.45;
const MIN_ANCHOR_LINE = ANCHOR_MIN_FONT_SIZE * LINE_HEIGHT_RATIO;
const PARAGRAPH_GAP_RATIO = 0.7;
const ANCHOR_GAP = MIN_ANCHOR_LINE + ANCHOR_MIN_FONT_SIZE * PARAGRAPH_GAP_RATIO;
const FOOTER_HEIGHT = 32;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const lineHeightOf = (line: { fontSize: number }) => line.fontSize * LINE_HEIGHT_RATIO;
const lineAdvance = (line: { fontSize: number; paragraphEnd: boolean }, isLast: boolean) =>
  lineHeightOf(line) + (line.paragraphEnd && !isLast ? line.fontSize * PARAGRAPH_GAP_RATIO : 0);

interface Token {
  text: string;
  kind: TranslationRunKind;
}

interface WrappedLine {
  runs: TranslationLayoutRun[];
  width: number;
}

function inlineSegments(text: string): Token[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return [{ text, kind: "text" }];
  return parts.flatMap((part, index) => part ? [{ text: part, kind: index % 2 ? "code" : "text" } as Token] : []);
}

function tokensForSegment(segment: Token): Token[] {
  const tokens: Token[] = [];
  let word = "";
  const flush = (): void => {
    if (!word) return;
    tokens.push({ text: word, kind: segment.kind });
    word = "";
  };
  for (const character of segment.text) {
    if (/\s/u.test(character)) {
      flush();
      if (tokens.at(-1)?.text !== " ") tokens.push({ text: " ", kind: segment.kind });
    } else if (CJK.test(character)) {
      flush();
      tokens.push({ text: character, kind: segment.kind });
    } else {
      word += character;
    }
  }
  flush();
  return tokens;
}

function paragraphTokens(text: string): Token[] {
  return inlineSegments(text).flatMap(tokensForSegment);
}

function appendRun(runs: TranslationLayoutRun[], token: Token, width: number): void {
  const previous = runs.at(-1);
  if (previous?.kind === token.kind) {
    previous.text += token.text;
    previous.width += width;
  } else {
    runs.push({ ...token, width });
  }
}

function wrapParagraph(
  paragraph: string,
  fontSize: number,
  serif: SerifKind,
  weight: 400 | 700,
  maximumWidth: number,
  measureText: TranslationTextMeasurer
): WrappedLine[] {
  const lines: WrappedLine[] = [];
  let runs: TranslationLayoutRun[] = [];
  let width = 0;
  const finishLine = (): void => {
    while (runs.at(-1)?.text === " ") {
      width -= runs.at(-1)?.width ?? 0;
      runs.pop();
    }
    if (runs.length) lines.push({ runs, width });
    runs = [];
    width = 0;
  };

  for (const token of paragraphTokens(paragraph)) {
    if (token.text === " " && !runs.length) continue;
    const tokenWidth = measureText(token.text, fontSize, token.kind, serif, weight);
    if (tokenWidth <= maximumWidth) {
      if (runs.length && width + tokenWidth > maximumWidth) finishLine();
      if (token.text !== " " || runs.length) {
        appendRun(runs, token, tokenWidth);
        width += tokenWidth;
      }
      continue;
    }

    for (const character of token.text) {
      const characterWidth = measureText(character, fontSize, token.kind, serif, weight);
      if (runs.length && width + characterWidth > maximumWidth) finishLine();
      appendRun(runs, { text: character, kind: token.kind }, characterWidth);
      width += characterWidth;
    }
  }
  finishLine();
  return lines;
}

function linesForParagraphs(
  paragraphs: readonly StyledParagraph[],
  base: number,
  maximumWidth: number,
  measureText: TranslationTextMeasurer
): Array<Omit<TranslationLayoutLine, "y">> {
  const lines: Array<Omit<TranslationLayoutLine, "y">> = [];
  for (const paragraph of paragraphs) {
    const fontSize = headingFontSize(base, paragraph.style.headingLevel);
    const serif = paragraph.style.serif;
    const weight = paragraph.style.fontWeight;
    const wrapped = wrapParagraph(paragraph.text, fontSize, serif, weight, maximumWidth, measureText);
    wrapped.forEach((line, index) => {
      lines.push({ ...line, fontSize, serif, weight, paragraphEnd: index === wrapped.length - 1 });
    });
  }
  return lines;
}

export function buildExclusionBands(
  regions: readonly PageImageRegion[],
  cssHeight: number,
  padding: number,
  footerY: number
): ExclusionBand[] {
  const bands: ExclusionBand[] = [];
  for (const region of regions) {
    const top = region.y * cssHeight;
    const height = region.height * cssHeight;
    if (height < 24) continue;
    const bandTop = Math.max(top - 6, padding);
    const bandBottom = Math.min(top + height + 6, footerY);
    if (bandBottom <= bandTop) continue;
    bands.push({ top: bandTop, bottom: bandBottom });
  }
  bands.sort((left, right) => left.top - right.top);
  const merged: ExclusionBand[] = [];
  for (const band of bands) {
    const previous = merged.at(-1);
    if (previous && band.top <= previous.bottom) {
      previous.bottom = Math.max(previous.bottom, band.bottom);
    } else {
      merged.push({ top: band.top, bottom: band.bottom });
    }
  }
  return merged;
}

function placeLines(
  candidate: readonly Omit<TranslationLayoutLine, "y">[],
  padding: number,
  footerY: number,
  bands: readonly ExclusionBand[],
  clip: boolean
): { lines: TranslationLayoutLine[]; overflow: boolean } {
  const lines: TranslationLayoutLine[] = [];
  let y = padding;
  let bandIndex = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    const line = candidate[index];
    if (!line) continue;
    const lineHeight = lineHeightOf(line);
    while (bandIndex < bands.length && (bands[bandIndex] as ExclusionBand).bottom <= y) bandIndex += 1;
    while (bandIndex < bands.length) {
      const band = bands[bandIndex] as ExclusionBand;
      if (y + lineHeight <= band.top) break;
      y = band.bottom;
      bandIndex += 1;
    }
    if (clip && y + lineHeight > footerY) return { lines, overflow: true };
    lines.push({ ...line, y });
    y += lineAdvance(line, index === candidate.length - 1);
  }
  const lastLine = lines.at(-1);
  return {
    lines,
    overflow: clip ? false : lastLine ? lastLine.y + lineHeightOf(lastLine) > footerY : false
  };
}

interface AnchorGroup {
  anchorY: number;
  fontSizeRatio: number;
  centered?: boolean;
  serif: SerifKind;
  weight: 400 | 700;
  text: string;
}

function isValidAnchor(paragraph: StyledParagraph): paragraph is StyledParagraph & { anchorY: number; fontSizeRatio: number } {
  return typeof paragraph.anchorY === "number"
    && Number.isFinite(paragraph.anchorY)
    && paragraph.anchorY >= 0
    && paragraph.anchorY <= 1
    && typeof paragraph.fontSizeRatio === "number"
    && Number.isFinite(paragraph.fontSizeRatio)
    && paragraph.fontSizeRatio > 0;
}

function anchorGroups(paragraphs: readonly StyledParagraph[]): AnchorGroup[] | undefined {
  if (!paragraphs.length) return undefined;
  const first = paragraphs[0];
  if (!first || !isValidAnchor(first)) return undefined;
  const groups: AnchorGroup[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.anchorY === undefined) {
      const current = groups.at(-1);
      if (current) current.text = `${current.text} ${paragraph.text}`;
      continue;
    }
    if (!isValidAnchor(paragraph)) return undefined;
    groups.push({
      anchorY: paragraph.anchorY,
      fontSizeRatio: paragraph.fontSizeRatio,
      centered: paragraph.centered,
      serif: paragraph.style.serif,
      weight: paragraph.style.fontWeight,
      text: paragraph.text
    });
  }
  return groups;
}

function appendEllipsis(
  line: TranslationLayoutLine,
  maximumWidth: number,
  measureText: TranslationTextMeasurer
): void {
  const ellipsisWidth = measureText("…", line.fontSize, "text", line.serif, line.weight);
  while (line.runs.length > 0 && line.width + ellipsisWidth > maximumWidth) {
    const last = line.runs[line.runs.length - 1];
    if (!last) break;
    const chars = [...last.text];
    if (chars.length <= 1) {
      line.runs.pop();
    } else {
      chars.pop();
      last.text = chars.join("");
      last.width = measureText(last.text, line.fontSize, last.kind, line.serif, line.weight);
    }
    line.width = line.runs.reduce((sum, run) => sum + run.width, 0);
  }
  appendRun(line.runs, { text: "…", kind: "text" }, ellipsisWidth);
  line.width += ellipsisWidth;
}

function layoutAnchoredTranslation(
  groups: readonly AnchorGroup[],
  cssWidth: number,
  cssHeight: number,
  measureText: TranslationTextMeasurer,
  exclusions: readonly PageImageRegion[]
): TranslationLayout {
  const horizontalPadding = Math.min(48, Math.max(24, cssWidth * 0.06));
  const maximumWidth = cssWidth - 2 * horizontalPadding;
  const footerY = Math.max(0, cssHeight - FOOTER_HEIGHT);
  const bands = buildExclusionBands(exclusions, cssHeight, 0, footerY);

  const lines: TranslationLayoutLine[] = [];
  let prevEnd = 0;
  let overflow = false;
  let minFontSize = Infinity;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (!group) continue;
    const rawAnchor = group.anchorY * cssHeight;
    let startY = Math.max(rawAnchor, prevEnd, 0);

    const nextGroup = groups[index + 1];
    const nextAnchorH = nextGroup ? nextGroup.anchorY * cssHeight : undefined;
    let slotEnd = footerY;
    for (let guard = 0; guard <= bands.length + 1; guard += 1) {
      startY = Math.min(Math.max(startY, 0), footerY);
      for (const band of bands) {
        if (band.top < startY && startY < band.bottom) {
          startY = band.bottom;
          break;
        }
      }

      slotEnd = footerY;
      let blockingBand: ExclusionBand | undefined;
      if (nextAnchorH !== undefined && nextAnchorH - startY + 1e-6 >= ANCHOR_GAP) {
        slotEnd = Math.min(slotEnd, nextAnchorH);
      }
      for (const band of bands) {
        if (band.top >= startY && band.top < slotEnd) {
          slotEnd = band.top;
          blockingBand = band;
          break;
        }
      }

      if (slotEnd - startY + 1e-6 < MIN_ANCHOR_LINE && blockingBand) {
        startY = blockingBand.bottom;
        continue;
      }
      break;
    }

    const desired = Math.min(ANCHOR_MAX_FONT_SIZE, Math.max(ANCHOR_DESIRED_MIN_FONT_SIZE, Math.round(group.fontSizeRatio * cssHeight)));
    let selectedFontSize = 0;
    let selectedWrapped: WrappedLine[] = [];
    let minWrapped: WrappedLine[] = [];
    for (let fontSize = desired; fontSize >= ANCHOR_MIN_FONT_SIZE; fontSize -= 1) {
      const wrapped = wrapParagraph(group.text, fontSize, group.serif, group.weight, maximumWidth, measureText);
      if (fontSize === ANCHOR_MIN_FONT_SIZE) minWrapped = wrapped;
      if (wrapped.length * fontSize * LINE_HEIGHT_RATIO <= slotEnd - startY) {
        selectedFontSize = fontSize;
        selectedWrapped = wrapped;
        break;
      }
    }

    const fits = selectedFontSize > 0;
    const fontSize = fits ? selectedFontSize : ANCHOR_MIN_FONT_SIZE;
    const wrapped = fits ? selectedWrapped : minWrapped;
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    let y = startY;
    const placedForGroup: TranslationLayoutLine[] = [];
    for (const candidate of wrapped) {
      if (!fits && y + lineHeight > slotEnd) break;
      placedForGroup.push({
        runs: candidate.runs,
        width: candidate.width,
        y,
        paragraphEnd: false,
        fontSize,
        serif: group.serif,
        weight: group.weight
      });
      y += lineHeight;
    }
    if (!fits) {
      overflow = true;
      const lastLine = placedForGroup.at(-1);
      if (lastLine) appendEllipsis(lastLine, maximumWidth, measureText);
    }
    if (group.centered === true) {
      for (const placed of placedForGroup) {
        placed.x = Math.max(horizontalPadding, (cssWidth - placed.width) / 2);
      }
    }
    const lastLine = placedForGroup.at(-1);
    if (lastLine) {
      lines.push(...placedForGroup);
      prevEnd = lastLine.y + lineHeight;
    } else {
      prevEnd = startY;
    }
    minFontSize = Math.min(minFontSize, fontSize);
  }

  const fontSize = Number.isFinite(minFontSize) ? minFontSize : ANCHOR_MIN_FONT_SIZE;
  const lastLine = lines.at(-1);
  return {
    fontSize,
    lineHeight: fontSize * LINE_HEIGHT_RATIO,
    paragraphGap: fontSize * PARAGRAPH_GAP_RATIO,
    padding: horizontalPadding,
    footerHeight: FOOTER_HEIGHT,
    footerY,
    bodyBottom: lastLine ? lastLine.y + lineHeightOf(lastLine) : 0,
    lines,
    overflow,
    footerText: overflow ? TRANSLATION_OVERFLOW_FOOTER : undefined
  };
}

export function layoutTranslation(
  paragraphs: readonly StyledParagraph[],
  cssWidth: number,
  cssHeight: number,
  measureText: TranslationTextMeasurer,
  exclusions?: readonly PageImageRegion[]
): TranslationLayout {
  const groups = anchorGroups(paragraphs);
  if (groups) {
    return layoutAnchoredTranslation(groups, cssWidth, cssHeight, measureText, exclusions ?? []);
  }
  const padding = Math.min(48, Math.max(24, cssWidth * 0.06));
  const maximumWidth = Math.max(1, cssWidth - padding * 2);
  const footerY = Math.max(padding, cssHeight - padding - FOOTER_HEIGHT);
  const bands = buildExclusionBands(exclusions ?? [], cssHeight, padding, footerY);

  for (let fontSize = MAX_FONT_SIZE; fontSize >= MIN_FONT_SIZE; fontSize -= 1) {
    const lineHeight = fontSize * LINE_HEIGHT_RATIO;
    const paragraphGap = fontSize * PARAGRAPH_GAP_RATIO;
    const candidate = linesForParagraphs(paragraphs, fontSize, maximumWidth, measureText);
    const placed = placeLines(candidate, padding, footerY, bands, false);
    if (!placed.overflow) {
      const lastLine = placed.lines.at(-1);
      return {
        fontSize,
        lineHeight,
        paragraphGap,
        padding,
        footerHeight: FOOTER_HEIGHT,
        footerY,
        bodyBottom: lastLine ? lastLine.y + lineHeightOf(lastLine) : padding,
        lines: placed.lines,
        overflow: false
      };
    }
  }

  const fontSize = MIN_FONT_SIZE;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const paragraphGap = fontSize * PARAGRAPH_GAP_RATIO;
  const candidate = linesForParagraphs(paragraphs, fontSize, maximumWidth, measureText);
  const placed = placeLines(candidate, padding, footerY, bands, true);
  const lastLine = placed.lines.at(-1);
  return {
    fontSize,
    lineHeight,
    paragraphGap,
    padding,
    footerHeight: FOOTER_HEIGHT,
    footerY,
    bodyBottom: lastLine ? lastLine.y + lineHeightOf(lastLine) : padding,
    lines: placed.lines,
    overflow: placed.overflow,
    footerText: placed.overflow ? TRANSLATION_OVERFLOW_FOOTER : undefined
  };
}

export function drawTranslationText(
  context: CanvasRenderingContext2D,
  layout: TranslationLayout,
  cssWidth: number
): void {
  context.save();
  context.textBaseline = "top";
  context.fillStyle = "#263c35";
  for (const line of layout.lines) {
    let x = line.x ?? layout.padding;
    for (const run of line.runs) {
      context.font = fontString(line.serif, run.kind, line.fontSize, line.weight);
      if (run.kind === "code") {
        context.fillStyle = "#eee8dc";
        context.fillRect(x - 1, line.y - 1, run.width + 2, lineHeightOf(line));
      }
      context.fillStyle = "#263c35";
      context.fillText(run.text, x, line.y);
      x += run.width;
    }
  }
  if (layout.overflow && layout.footerText) {
    context.strokeStyle = "#d8d0c3";
    context.beginPath();
    context.moveTo(layout.padding, layout.footerY);
    context.lineTo(cssWidth - layout.padding, layout.footerY);
    context.stroke();
    context.fillStyle = "#8f4937";
    context.font = `${TRANSLATION_FOOTER_FONT_SIZE}px system-ui, sans-serif`;
    context.fillText(layout.footerText, layout.padding, layout.footerY + 9);
  }
  context.restore();
}
