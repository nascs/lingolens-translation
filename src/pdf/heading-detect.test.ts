import { describe, expect, it } from "vitest";
import { baselineFontSize, detectHeadingLevels, type HeadingInput } from "./heading-detect";

const input = (fontSize: number, text = "Heading", lineCount = 1): HeadingInput => ({
  fontSize,
  charCount: text.length,
  lineCount,
  text
});

describe("baselineFontSize", () => {
  it("computes the character-weighted median font size", () => {
    const inputs: HeadingInput[] = [
      { fontSize: 10, charCount: 100, lineCount: 1, text: "a".repeat(100) },
      { fontSize: 12, charCount: 1, lineCount: 1, text: "b" },
      { fontSize: 20, charCount: 1, lineCount: 1, text: "c" }
    ];
    expect(baselineFontSize(inputs)).toBe(10);
  });

  it("weights larger bodies toward their font size", () => {
    const inputs: HeadingInput[] = [
      { fontSize: 20, charCount: 1, lineCount: 1, text: "t" },
      { fontSize: 12, charCount: 9, lineCount: 1, text: "b".repeat(9) }
    ];
    expect(baselineFontSize(inputs)).toBe(12);
  });

  it("returns zero for no inputs", () => {
    expect(baselineFontSize([])).toBe(0);
  });
});

describe("detectHeadingLevels", () => {
  const body = (fontSize = 10): HeadingInput => input(fontSize, "Body text");

  it("classifies heading levels at the exact ratio thresholds", () => {
    const page = (fontSize: number) => [body(), body(), input(fontSize, "Heading")];
    expect(detectHeadingLevels(page(16), { baseline: 10 })).toEqual([0, 0, 1]);
    expect(detectHeadingLevels(page(15.9), { baseline: 10 })).toEqual([0, 0, 2]);
    expect(detectHeadingLevels(page(13), { baseline: 10 })).toEqual([0, 0, 2]);
    expect(detectHeadingLevels(page(12.9), { baseline: 10 })).toEqual([0, 0, 3]);
    expect(detectHeadingLevels(page(11.5), { baseline: 10 })).toEqual([0, 0, 3]);
    expect(detectHeadingLevels(page(11.4), { baseline: 10 })).toEqual([0, 0, 0]);
  });

  it("rejects headings longer than 80 characters", () => {
    const page = [body(), body(), input(16, "x".repeat(81))];
    expect(detectHeadingLevels(page, { baseline: 10 })).toEqual([0, 0, 0]);
  });

  it("rejects multi-line headings", () => {
    const page = [body(), body(), input(16, "Heading", 2)];
    expect(detectHeadingLevels(page, { baseline: 10 })).toEqual([0, 0, 0]);
  });

  it("rejects headings ending with sentence punctuation", () => {
    const page = [body(), body(), input(16, "Heading.")];
    expect(detectHeadingLevels(page, { baseline: 10 })).toEqual([0, 0, 0]);
  });

  it("returns all zero for a page with uniform font sizes", () => {
    expect(detectHeadingLevels([input(12, "A"), input(12, "B"), input(12.5, "C")])).toEqual([0, 0, 0]);
  });

  it("returns all zero for fewer than three paragraphs", () => {
    expect(detectHeadingLevels([input(16, "Big"), input(12, "Small")])).toEqual([0, 0]);
  });

  it("rejects pages with more than six heading candidates", () => {
    const page = [
      ...Array.from({ length: 7 }, () => input(16, "Heading")),
      body(),
      body(),
      body()
    ];
    expect(detectHeadingLevels(page, { baseline: 10 })).toEqual(Array(10).fill(0));
  });
});
