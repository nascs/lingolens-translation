import { describe, expect, it } from "vitest";
import type { PdfTranslationItem } from "./queue";
import { buildPageTranslationState } from "./translation-state";
import type { ParagraphStyle } from "./style";

const style: ParagraphStyle = { headingLevel: 0, serif: "serif", fontWeight: 400 };

const items: PdfTranslationItem[] = [
  { id: "page-1-a", pageNumber: 1, text: "a", style },
  { id: "page-1-b", pageNumber: 1, text: "b", style },
  { id: "page-1-c", pageNumber: 1, text: "c", style }
];

describe("buildPageTranslationState", () => {
  it("uses stable item order rather than map insertion order", () => {
    const translations = new Map([
      ["page-1-c", "第三段"],
      ["page-1-a", "第一段"],
      ["page-1-b", "第二段"]
    ]);
    const state = buildPageTranslationState(items, translations);
    expect(state.paragraphs.map((paragraph) => paragraph.text)).toEqual(["第一段", "第二段", "第三段"]);
    expect(state.text).toBe("第一段\n\n第二段\n\n第三段");
    expect(state.status).toBe("complete");
  });

  it("marks missing results as partial without pretending completeness", () => {
    const state = buildPageTranslationState(items, new Map([["page-1-b", "第二段"]]));
    expect(state).toMatchObject({
      paragraphs: [{ text: "第二段", style }],
      text: "第二段",
      status: "partial",
      availableItemIds: ["page-1-b"],
      missingItemIds: ["page-1-a", "page-1-c"]
    });
  });

  it("preserves each paragraph's style in the output", () => {
    const headingStyle: ParagraphStyle = { headingLevel: 1, serif: "sans", fontWeight: 700 };
    const mixed: PdfTranslationItem[] = [
      { id: "p-1", pageNumber: 1, text: "a", style: headingStyle },
      { id: "p-2", pageNumber: 1, text: "b", style }
    ];
    const state = buildPageTranslationState(mixed, new Map([["p-1", "译文一"], ["p-2", "译文二"]]));
    expect(state.paragraphs).toEqual([
      { text: "译文一", style: headingStyle },
      { text: "译文二", style }
    ]);
  });

  it("marks failed items as partial even before any text is available", () => {
    expect(buildPageTranslationState(items, new Map(), new Set(["page-1-a"])).status).toBe("partial");
  });

  it("returns an empty copy string for pages with no available translation", () => {
    expect(buildPageTranslationState([], new Map())).toEqual({
      paragraphs: [],
      text: "",
      status: "empty",
      availableItemIds: [],
      missingItemIds: []
    });
  });

  it("passes chunk-0 anchor through and keeps later chunks anchorless", () => {
    const anchored: PdfTranslationItem[] = [
      { id: "g0-c0", pageNumber: 1, text: "first", style, anchorY: 0.1, fontSizeRatio: 0.02 },
      { id: "g0-c1", pageNumber: 1, text: "second", style },
      { id: "g0-c2", pageNumber: 1, text: "third", style }
    ];
    const translations = new Map([["g0-c0", "一"], ["g0-c1", "二"], ["g0-c2", "三"]]);
    const state = buildPageTranslationState(anchored, translations);
    expect(state.paragraphs.map((paragraph) => paragraph.anchorY)).toEqual([0.1, undefined, undefined]);
    expect(state.paragraphs.map((paragraph) => paragraph.fontSizeRatio)).toEqual([0.02, undefined, undefined]);
    expect(state.text).toBe("一\n\n二\n\n三");
  });

  it("promotes the first available continuation when chunk-0 is missing", () => {
    const anchored: PdfTranslationItem[] = [
      { id: "g0-c0", pageNumber: 1, text: "first", style, anchorY: 0.1, fontSizeRatio: 0.02 },
      { id: "g0-c1", pageNumber: 1, text: "second", style },
      { id: "g0-c2", pageNumber: 1, text: "third", style }
    ];
    const translations = new Map([["g0-c1", "二"], ["g0-c2", "三"]]);
    const state = buildPageTranslationState(anchored, translations);
    expect(state.paragraphs.map((paragraph) => paragraph.anchorY)).toEqual([0.1, undefined]);
    expect(state.paragraphs.map((paragraph) => paragraph.fontSizeRatio)).toEqual([0.02, undefined]);
    expect(state.text).toBe("二\n\n三");
  });

  it("does not leak a prior anchor into the next group", () => {
    const anchored: PdfTranslationItem[] = [
      { id: "g0-c0", pageNumber: 1, text: "first", style, anchorY: 0.1, fontSizeRatio: 0.02 },
      { id: "g1-c0", pageNumber: 1, text: "second", style, anchorY: 0.6, fontSizeRatio: 0.015 }
    ];
    const translations = new Map([["g1-c0", "二"]]);
    const state = buildPageTranslationState(anchored, translations);
    expect(state.paragraphs.map((paragraph) => paragraph.anchorY)).toEqual([0.6]);
    expect(state.paragraphs.map((paragraph) => paragraph.fontSizeRatio)).toEqual([0.015]);
    expect(state.text).toBe("二");
  });

  it("promotes anchor, font, and centered to the first available continuation", () => {
    const anchored: PdfTranslationItem[] = [
      { id: "g0-c0", pageNumber: 1, text: "first", style, anchorY: 0.1, fontSizeRatio: 0.02, centered: true },
      { id: "g0-c1", pageNumber: 1, text: "second", style },
      { id: "g0-c2", pageNumber: 1, text: "third", style }
    ];
    const translations = new Map([["g0-c1", "二"], ["g0-c2", "三"]]);
    const state = buildPageTranslationState(anchored, translations);
    expect(state.paragraphs.map((paragraph) => paragraph.anchorY)).toEqual([0.1, undefined]);
    expect(state.paragraphs.map((paragraph) => paragraph.fontSizeRatio)).toEqual([0.02, undefined]);
    expect(state.paragraphs.map((paragraph) => paragraph.centered)).toEqual([true, undefined]);
  });

  it("overwrites a prior group's centered, preserving an explicit false", () => {
    const anchored: PdfTranslationItem[] = [
      { id: "g0-c0", pageNumber: 1, text: "first", style, anchorY: 0.1, fontSizeRatio: 0.02, centered: true },
      { id: "g1-c0", pageNumber: 1, text: "second", style, anchorY: 0.6, fontSizeRatio: 0.015, centered: false }
    ];
    const translations = new Map([["g1-c0", "二"]]);
    const state = buildPageTranslationState(anchored, translations);
    expect(state.paragraphs.map((paragraph) => paragraph.anchorY)).toEqual([0.6]);
    expect(state.paragraphs.map((paragraph) => paragraph.centered)).toEqual([false]);
  });

  it("does not leak a prior group's centered when the new anchor omits it", () => {
    const anchored: PdfTranslationItem[] = [
      { id: "g0-c0", pageNumber: 1, text: "first", style, anchorY: 0.1, fontSizeRatio: 0.02, centered: true },
      { id: "g1-c0", pageNumber: 1, text: "second", style, anchorY: 0.6, fontSizeRatio: 0.015 }
    ];
    const translations = new Map([["g1-c0", "二"]]);
    const state = buildPageTranslationState(anchored, translations);
    expect(state.paragraphs.map((paragraph) => paragraph.anchorY)).toEqual([0.6]);
    expect(state.paragraphs.map((paragraph) => paragraph.centered)).toEqual([undefined]);
  });
});
