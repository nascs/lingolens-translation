import type { PdfTranslationItem } from "./queue";
import type { ParagraphStyle, StyledParagraph } from "./style";

export type PageTranslationStatus = "empty" | "partial" | "complete";

const DEFAULT_PARAGRAPH_STYLE: ParagraphStyle = { headingLevel: 0, serif: "serif", fontWeight: 400 };

export interface PageTranslationState {
  paragraphs: StyledParagraph[];
  text: string;
  status: PageTranslationStatus;
  availableItemIds: string[];
  missingItemIds: string[];
}

export function buildPageTranslationState(
  items: readonly PdfTranslationItem[],
  translatedById: ReadonlyMap<string, string>,
  failedItemIds: ReadonlySet<string> = new Set<string>()
): PageTranslationState {
  const paragraphs: StyledParagraph[] = [];
  const availableItemIds: string[] = [];
  const missingItemIds: string[] = [];
  let pendingAnchor: { anchorY: number; fontSizeRatio: number | undefined; centered?: boolean } | undefined;
  for (const item of items) {
    if (item.anchorY !== undefined) {
      pendingAnchor = { anchorY: item.anchorY, fontSizeRatio: item.fontSizeRatio, centered: item.centered };
    }
    const translated = translatedById.get(item.id)?.trim();
    if (translated) {
      const paragraph: StyledParagraph = { text: translated, style: item.style ?? DEFAULT_PARAGRAPH_STYLE };
      if (pendingAnchor) {
        paragraph.anchorY = pendingAnchor.anchorY;
        if (pendingAnchor.fontSizeRatio !== undefined) paragraph.fontSizeRatio = pendingAnchor.fontSizeRatio;
        if (pendingAnchor.centered !== undefined) paragraph.centered = pendingAnchor.centered;
        pendingAnchor = undefined;
      }
      paragraphs.push(paragraph);
      availableItemIds.push(item.id);
    } else {
      missingItemIds.push(item.id);
    }
  }
  const failed = items.some(({ id }) => failedItemIds.has(id));
  const status: PageTranslationStatus = !items.length || (!paragraphs.length && !failed)
    ? "empty"
    : missingItemIds.length || failed
      ? "partial"
      : "complete";
  return {
    paragraphs,
    text: paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
    status,
    availableItemIds,
    missingItemIds
  };
}
