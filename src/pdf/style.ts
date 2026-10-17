import { majoritySerif } from "./font-classify";
import { HEADING_LEVEL_RATIOS, detectHeadingLevels } from "./heading-detect";
import type { ParagraphShape } from "./text";

export type HeadingLevel = 0 | 1 | 2 | 3;
export type SerifKind = "serif" | "sans";

export interface ParagraphStyle {
  headingLevel: HeadingLevel;
  serif: SerifKind;
  fontWeight: 400 | 700;
}

export interface StyledParagraph {
  text: string;
  style: ParagraphStyle;
  anchorY?: number;
  fontSizeRatio?: number;
  centered?: boolean;
}

export function headingFontSize(baseFontSize: number, level: HeadingLevel): number {
  if (level === 0) return baseFontSize;
  return Math.round(baseFontSize * HEADING_LEVEL_RATIOS[level]);
}

export function styleParagraphs(shapes: readonly ParagraphShape[], documentSerif: SerifKind | undefined): StyledParagraph[] {
  const pageMajority = majoritySerif(shapes.map((shape) => ({ serif: shape.serif, chars: shape.charCount })));
  const levels = detectHeadingLevels(shapes.map((shape) => ({
    fontSize: shape.fontSize,
    charCount: shape.charCount,
    lineCount: shape.lineCount,
    text: shape.text
  })));
  const allAnchored = shapes.every((shape) =>
    typeof shape.topY === "number" && Number.isFinite(shape.topY)
    && typeof shape.bottomY === "number" && Number.isFinite(shape.bottomY)
    && shape.topY >= 0 && shape.topY <= shape.bottomY && shape.bottomY <= 1
    && typeof shape.fontSizeRatio === "number" && Number.isFinite(shape.fontSizeRatio) && shape.fontSizeRatio > 0
  );
  return shapes.map((shape, index) => {
    const headingLevel = levels[index] ?? 0;
    const styled: StyledParagraph = {
      text: shape.text,
      style: {
        headingLevel,
        serif: shape.serif ?? pageMajority ?? documentSerif ?? "serif",
        fontWeight: headingLevel > 0 ? 700 : 400
      }
    };
    if (allAnchored && shape.topY !== undefined) {
      styled.anchorY = shape.topY;
      styled.fontSizeRatio = shape.fontSizeRatio;
      if (shape.centered !== undefined) styled.centered = shape.centered;
    }
    return styled;
  });
}
