import { describe, expect, it, vi } from "vitest";
import {
  MAX_DETECTION_CHARACTERS,
  MAX_EXTRACTED_CHARACTERS,
  MAX_NONZERO_CANVASES,
  MAX_RENDERED_PAGE_PAIRS,
  DocumentTargetResolver,
  applyCharacterLimit,
  assertPdfPageLimit,
  collectDetectionSample,
  createPageCanvasSize,
  planCanvasReconciliation,
  resolveDocumentTarget,
  selectRetainedCanvasPages,
  type ExtractedPage
} from "./document";
import type { ParagraphShape } from "./text";

const shape = (text: string): ParagraphShape => ({
  text,
  fontSize: 12,
  charCount: text.length,
  lineCount: 1,
  serif: undefined
});

describe("PDF document limits", () => {
  it("accepts at most 300 pages", () => {
    expect(() => assertPdfPageLimit(300)).not.toThrow();
    expect(() => assertPdfPageLimit(301)).toThrow("300");
  });

  it("caps extracted text at 500,000 characters", () => {
    const result = applyCharacterLimit([shape("a".repeat(20))], MAX_EXTRACTED_CHARACTERS - 10);
    expect(result.paragraphs.map((paragraph) => paragraph.text)).toEqual(["a".repeat(10)]);
    expect(result.paragraphs[0]).toMatchObject({ charCount: 20, lineCount: 1 });
    expect(result.usedCharacters).toBe(MAX_EXTRACTED_CHARACTERS);
    expect(result.limitReached).toBe(true);
    expect(applyCharacterLimit([shape("ignored")], MAX_EXTRACTED_CHARACTERS).paragraphs).toEqual([]);
  });

  it("caps DPR at two and reports exact CSS/backing dimensions", () => {
    expect(createPageCanvasSize(333.2, 444.4, 3)).toEqual({
      cssWidth: 334,
      cssHeight: 445,
      backingWidth: 667,
      backingHeight: 889,
      dpr: 2
    });
  });

  it("preserves anchor geometry fields when truncating a paragraph", () => {
    const anchored: ParagraphShape = {
      text: "x".repeat(20),
      fontSize: 12,
      charCount: 20,
      lineCount: 1,
      serif: undefined,
      topY: 0.2,
      bottomY: 0.25,
      fontSizeRatio: 0.02,
      centered: true
    };
    const result = applyCharacterLimit([anchored], 0, 10);
    expect(result.paragraphs).toEqual([{ ...anchored, text: "x".repeat(10) }]);
    expect(result.paragraphs[0]).toMatchObject({ topY: 0.2, bottomY: 0.25, fontSizeRatio: 0.02, centered: true });
  });
});

describe("document language sample", () => {
  const pages: ExtractedPage[] = [
    { pageNumber: 1, paragraphs: [] },
    { pageNumber: 2, paragraphs: [shape("first")] },
    { pageNumber: 3, paragraphs: [shape("second")] },
    { pageNumber: 4, paragraphs: [] },
    { pageNumber: 5, paragraphs: [shape("third")] },
    { pageNumber: 6, paragraphs: [shape("not sampled")] }
  ];

  it("takes the first three non-empty pages in page order", () => {
    expect(collectDetectionSample(pages)).toBe("first\n\nsecond\n\nthird");
  });

  it("truncates the combined sample to 4000 characters", () => {
    const sample = collectDetectionSample([
      { pageNumber: 1, paragraphs: [shape("a".repeat(3000))] },
      { pageNumber: 2, paragraphs: [shape("b".repeat(3000))] }
    ]);
    expect(sample).toHaveLength(MAX_DETECTION_CHARACTERS);
    expect(sample.startsWith("a".repeat(3000))).toBe(true);
  });

  it("calls the detector once for a smart document and includes mixed pages", async () => {
    const detector = vi.fn(async (text: string) => ({
      isReliable: true,
      languages: [{ language: text.includes("English") && text.includes("中文") ? "en" : "und", percentage: 100 }]
    }));
    const result = await resolveDocumentTarget([
      { pageNumber: 1, paragraphs: [shape("English")] },
      { pageNumber: 2, paragraphs: [shape("中文")] }
    ], "smart", detector);
    expect(result.resolvedTargetLanguage).toBe("zh-CN");
    expect(detector).toHaveBeenCalledOnce();
  });

  it("passes a manual target through without calling the detector", async () => {
    const detector = vi.fn(async () => ({ isReliable: true, languages: [{ language: "zh", percentage: 100 }] }));
    const result = await resolveDocumentTarget(pages, "ja", detector);
    expect(result.resolvedTargetLanguage).toBe("ja");
    expect(detector).not.toHaveBeenCalled();
  });

  it("detects smart once per document generation and reuses it after manual targets", async () => {
    const detector = vi.fn(async () => ({ isReliable: true, languages: [{ language: "en", percentage: 100 }] }));
    const resolver = new DocumentTargetResolver(detector);
    await resolver.resolve(10, pages, "smart");
    await resolver.resolve(10, pages, "smart");
    await resolver.resolve(10, pages, "ja");
    await resolver.resolve(10, pages, "smart");
    expect(detector).toHaveBeenCalledOnce();
    await resolver.resolve(11, pages, "smart");
    expect(detector).toHaveBeenCalledTimes(2);
  });

  it("does not detect for manual targets before smart is selected", async () => {
    const detector = vi.fn(async () => ({ isReliable: true, languages: [{ language: "en", percentage: 100 }] }));
    const resolver = new DocumentTargetResolver(detector);
    await expect(resolver.resolve(1, pages, "fr")).resolves.toMatchObject({ resolvedTargetLanguage: "fr" });
    expect(detector).not.toHaveBeenCalled();
    await resolver.resolve(1, pages, "smart");
    expect(detector).toHaveBeenCalledOnce();
  });
});

describe("canvas retention", () => {
  it("keeps no more than four visible/neighboring page pairs", () => {
    expect(selectRetainedCanvasPages([10], 30)).toEqual([8, 9, 10, 11]);
    expect(selectRetainedCanvasPages([1], 3)).toEqual([1, 2, 3]);
    expect(selectRetainedCanvasPages([], 10)).toEqual([]);
    expect(MAX_RENDERED_PAGE_PAIRS * 2).toBe(MAX_NONZERO_CANVASES);
  });

  it("excludes failed pages before the four-pair limit and fills the nearest valid page", () => {
    const desired = selectRetainedCanvasPages([1], 12, MAX_RENDERED_PAGE_PAIRS, [1]);
    expect(desired).toEqual([2, 3, 4, 5]);
    const plan = planCanvasReconciliation(desired, [], []);
    expect(plan.start).toEqual(desired);
    expect(plan.start).toHaveLength(MAX_RENDERED_PAGE_PAIRS);
  });

  it("starts only four page pairs when a large viewport desires more", () => {
    const plan = planCanvasReconciliation([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], [], []);
    expect(plan.start).toEqual([1, 2, 3, 4]);
  });

  it("counts rendering and rendered canvases before starting more", () => {
    const plan = planCanvasReconciliation([1, 2, 3, 4], [1, 2], [3, 4]);
    expect(plan.start).toEqual([]);
    expect((2 + 2 + plan.start.length) * 2).toBeLessThanOrEqual(MAX_NONZERO_CANVASES);
  });

  it("cancels old in-flight pages and waits for slots before a fast page jump", () => {
    const first = planCanvasReconciliation(
      [17, 18, 19, 20],
      [1, 2, 3, 4],
      []
    );
    expect(first.cancel).toEqual([1, 2, 3, 4]);
    expect(first.start).toEqual([]);
    const afterRelease = planCanvasReconciliation([17, 18, 19, 20], [], []);
    expect(afterRelease.start).toEqual([17, 18, 19, 20]);
  });

  it("evicts completed non-desired pages before filling free slots", () => {
    const plan = planCanvasReconciliation([20, 21, 22, 23], [20], [1, 2, 21]);
    expect(plan.evict).toEqual([1, 2]);
    expect(plan.start).toEqual([22, 23]);
    expect(1 + 1 + plan.start.length).toBe(MAX_RENDERED_PAGE_PAIRS);
  });
});
