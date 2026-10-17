import { describe, expect, it } from "vitest";
import { headingFontSize, styleParagraphs } from "./style";
import type { ParagraphShape } from "./text";

const shape = (text: string, options: Partial<ParagraphShape> = {}): ParagraphShape => ({
  text,
  fontSize: 12,
  charCount: text.length,
  lineCount: 1,
  serif: undefined,
  ...options
});

describe("headingFontSize", () => {
  it("returns the base size for level zero", () => {
    expect(headingFontSize(20, 0)).toBe(20);
  });

  it("scales and rounds heading levels by the shared ratios", () => {
    expect(headingFontSize(20, 1)).toBe(32);
    expect(headingFontSize(20, 2)).toBe(26);
    expect(headingFontSize(20, 3)).toBe(23);
    expect(headingFontSize(19, 3)).toBe(22);
    expect(headingFontSize(13, 2)).toBe(17);
  });
});

describe("styleParagraphs", () => {
  it("falls back per-shape to page majority to document majority to default serif", () => {
    const pageShaped: ParagraphShape[] = [
      shape("A", { serif: "sans" }),
      shape("B")
    ];
    const fromShape = styleParagraphs(pageShaped, "serif");
    expect(fromShape.map((paragraph) => paragraph.style.serif)).toEqual(["sans", "sans"]);

    const noShapeInfo: ParagraphShape[] = [shape("A"), shape("B")];
    expect(styleParagraphs(noShapeInfo, "serif").map((paragraph) => paragraph.style.serif)).toEqual(["serif", "serif"]);
    expect(styleParagraphs(noShapeInfo, undefined).map((paragraph) => paragraph.style.serif)).toEqual(["serif", "serif"]);
  });

  it("assigns bold weight and heading level for detected headings", () => {
    const shapes: ParagraphShape[] = [
      shape("Body one", { fontSize: 12 }),
      shape("Body two", { fontSize: 12 }),
      shape("Heading", { fontSize: 20 })
    ];
    const styled = styleParagraphs(shapes, "serif");
    expect(styled[2]?.style).toEqual({ headingLevel: 1, serif: "serif", fontWeight: 700 });
    expect(styled[0]?.style.fontWeight).toBe(400);
    expect(styled[0]?.style.headingLevel).toBe(0);
  });

  it("maps anchorY and fontSizeRatio when every shape has valid geometry", () => {
    const shapes = [
      shape("A", { topY: 0.1, bottomY: 0.2, fontSizeRatio: 0.02 }),
      shape("B", { topY: 0.5, bottomY: 0.6, fontSizeRatio: 0.015 })
    ];
    const styled = styleParagraphs(shapes, "serif");
    expect(styled.map((paragraph) => paragraph.anchorY)).toEqual([0.1, 0.5]);
    expect(styled.map((paragraph) => paragraph.fontSizeRatio)).toEqual([0.02, 0.015]);
  });

  it("disables anchoring for the whole page when any shape is missing or invalid", () => {
    const missing = [
      shape("A", { topY: 0.1, bottomY: 0.2, fontSizeRatio: 0.02 }),
      shape("B")
    ];
    const fromMissing = styleParagraphs(missing, "serif");
    expect(fromMissing.every((paragraph) => paragraph.anchorY === undefined && paragraph.fontSizeRatio === undefined)).toBe(true);

    const invalid = [
      shape("A", { topY: 0.1, bottomY: 0.2, fontSizeRatio: 0.02 }),
      shape("B", { topY: 0.1, bottomY: 0.05, fontSizeRatio: 0.02 })
    ];
    const fromInvalid = styleParagraphs(invalid, "serif");
    expect(fromInvalid.every((paragraph) => paragraph.anchorY === undefined)).toBe(true);
  });

  it("passes centered through when anchored, including false", () => {
    const shapes = [
      shape("A", { topY: 0.1, bottomY: 0.2, fontSizeRatio: 0.02, centered: true }),
      shape("B", { topY: 0.5, bottomY: 0.6, fontSizeRatio: 0.015, centered: false })
    ];
    const styled = styleParagraphs(shapes, "serif");
    expect(styled.map((paragraph) => paragraph.centered)).toEqual([true, false]);
  });

  it("omits centered everywhere when anchoring is disabled for the whole page", () => {
    const shapes = [
      shape("A", { topY: 0.1, bottomY: 0.2, fontSizeRatio: 0.02, centered: true }),
      shape("B")
    ];
    const styled = styleParagraphs(shapes, "serif");
    expect(styled.every((paragraph) => paragraph.centered === undefined)).toBe(true);
  });

  it("keeps heading bold weight unchanged when anchoring", () => {
    const shapes = [
      shape("Body one", { fontSize: 12, topY: 0.4, bottomY: 0.45, fontSizeRatio: 0.012 }),
      shape("Body two", { fontSize: 12, topY: 0.5, bottomY: 0.55, fontSizeRatio: 0.012 }),
      shape("Heading", { fontSize: 20, topY: 0.1, bottomY: 0.15, fontSizeRatio: 0.02 })
    ];
    const styled = styleParagraphs(shapes, "serif");
    expect(styled[2]?.style).toEqual({ headingLevel: 1, serif: "serif", fontWeight: 700 });
    expect(styled[2]?.anchorY).toBe(0.1);
    expect(styled[0]?.style.fontWeight).toBe(400);
  });
});
