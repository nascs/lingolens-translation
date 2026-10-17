import { describe, expect, it, vi } from "vitest";
import { MONOSPACE_STACK, SANS_STACK, SERIF_STACK, type SerifKind } from "./font-classify";
import {
  buildExclusionBands,
  drawTranslationText,
  fontString,
  layoutTranslation,
  TRANSLATION_FOOTER_FONT_SIZE,
  TRANSLATION_OVERFLOW_FOOTER,
  type TranslationLayout,
  type TranslationRunKind
} from "./translation-layout";
import type { HeadingLevel, StyledParagraph } from "./style";
import type { PageImageRegion } from "./document";

const para = (text: string, headingLevel: HeadingLevel = 0, serif: SerifKind = "serif"): StyledParagraph => ({
  text,
  style: { headingLevel, serif, fontWeight: headingLevel > 0 ? 700 : 400 }
});

const measure = (text: string, fontSize: number, kind: TranslationRunKind, _serif: SerifKind, _weight: 400 | 700) =>
  [...text].length * fontSize * (kind === "code" ? 0.62 : 0.5);

const region = (y: number, height: number, x = 0, width = 1): PageImageRegion => ({ x, y, width, height });

const visibleText = (layout: TranslationLayout) => layout.lines
  .map((line) => line.runs.map(({ text }) => text).join(""))
  .join("\n");

describe("layoutTranslation", () => {
  it("uses clamped padding, fixed ratios, and a 32px footer reservation", () => {
    const narrow = layoutTranslation([para("text")], 200, 300, measure);
    const wide = layoutTranslation([para("text")], 1000, 300, measure);
    expect(narrow.padding).toBe(24);
    expect(wide.padding).toBe(48);
    expect(narrow.lineHeight).toBe(narrow.fontSize * 1.45);
    expect(narrow.paragraphGap).toBe(narrow.fontSize * 0.7);
    expect(narrow.footerHeight).toBe(32);
  });

  it("wraps CJK by character", () => {
    const layout = layoutTranslation([para("天地玄黄宇宙洪荒")], 120, 300, measure);
    expect(layout.lines.length).toBeGreaterThan(1);
    expect(visibleText(layout).replaceAll("\n", "")).toBe("天地玄黄宇宙洪荒");
  });

  it("wraps Latin at spaces without losing words", () => {
    const layout = layoutTranslation([para("alpha beta gamma delta")], 150, 300, measure);
    expect(visibleText(layout).replaceAll("\n", " ").split(/\s+/)).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("handles mixed text and safely breaks an overlong word", () => {
    const layout = layoutTranslation([para(`中文 ${"x".repeat(80)} mixed`)], 150, 500, measure);
    expect(layout.lines.length).toBeGreaterThan(2);
    expect(visibleText(layout)).toContain("中文");
    expect(visibleText(layout).replaceAll("\n", "")).toContain("x".repeat(80));
  });

  it("measures inline backtick code as monospace without losing content", () => {
    const layout = layoutTranslation([para("Use `const value = 1` now")], 300, 300, measure);
    const code = layout.lines.flatMap(({ runs }) => runs).filter(({ kind }) => kind === "code");
    expect(code.map(({ text }) => text).join("")).toBe("const value = 1");
    expect(visibleText(layout)).toContain("const value = 1");
  });

  it("chooses the largest fitting integer font from 20 down to 12", () => {
    expect(layoutTranslation([para("short")], 500, 300, measure).fontSize).toBe(20);
    const crowded = layoutTranslation([para("word ".repeat(70))], 260, 260, measure);
    expect(Number.isInteger(crowded.fontSize)).toBe(true);
    expect(crowded.fontSize).toBeGreaterThanOrEqual(12);
    expect(crowded.fontSize).toBeLessThan(20);
  });

  it("clips overflowing body above a fixed footer", () => {
    const layout = layoutTranslation([para("内容".repeat(500))], 180, 180, measure);
    expect(layout).toMatchObject({ overflow: true, footerHeight: 32, footerText: TRANSLATION_OVERFLOW_FOOTER });
    expect(layout.fontSize).toBe(12);
    expect(TRANSLATION_FOOTER_FONT_SIZE).toBe(12);
    expect(layout.lines.every((line) => line.y + layout.lineHeight <= layout.footerY)).toBe(true);
    expect(layout.bodyBottom).toBeLessThanOrEqual(layout.footerY);
  });

  it("renders L1 headings larger and bold", () => {
    const layout = layoutTranslation([para("Chapter", 1)], 500, 300, measure);
    expect(layout.fontSize).toBe(20);
    expect(layout.lines[0]?.fontSize).toBe(32);
    expect(layout.lines[0]?.weight).toBe(700);
    expect(layout.lines[0]?.serif).toBe("serif");
  });

  it("records per-line serif and weight for styled paragraphs", () => {
    const layout = layoutTranslation([para("Sans heading", 2, "sans"), para("Serif body")], 500, 300, measure);
    expect(layout.lines[0]?.serif).toBe("sans");
    expect(layout.lines[0]?.weight).toBe(700);
    expect(layout.lines[0]?.fontSize).toBe(26);
    expect(layout.lines[1]?.serif).toBe("serif");
    expect(layout.lines[1]?.weight).toBe(400);
    expect(layout.lines[1]?.fontSize).toBe(20);
  });

  it("keeps L1 heading lines from crossing the footer when overflowing", () => {
    const layout = layoutTranslation([para("Title", 1), para("内容".repeat(500))], 180, 180, measure);
    expect(layout.overflow).toBe(true);
    expect(layout.fontSize).toBe(12);
    for (const line of layout.lines) {
      expect(line.y + line.fontSize * 1.45).toBeLessThanOrEqual(layout.footerY);
    }
    expect(layout.bodyBottom).toBeLessThanOrEqual(layout.footerY);
  });

  it("shifts lines clear of a middle exclusion band", () => {
    const regions = [region(0.35, 0.15)];
    const layout = layoutTranslation([para("text")], 400, 500, measure, regions);
    const bands = buildExclusionBands(regions, 500, layout.padding, layout.footerY);
    expect(bands).not.toEqual([]);
    for (const line of layout.lines) {
      const lineHeight = line.fontSize * 1.45;
      for (const band of bands) {
        expect(line.y >= band.bottom || line.y + lineHeight <= band.top).toBe(true);
      }
    }
  });

  it("degrades the font size or overflows when a large band crowds the body", () => {
    const layout = layoutTranslation([para("内容".repeat(500))], 400, 500, measure, [region(0.4, 0.4)]);
    expect(layout.fontSize < 20 || (layout.overflow && layout.footerText === TRANSLATION_OVERFLOW_FOOTER)).toBe(true);
    for (const line of layout.lines) {
      expect(line.y + line.fontSize * 1.45).toBeLessThanOrEqual(layout.footerY);
    }
    expect(layout.bodyBottom).toBeLessThanOrEqual(layout.footerY);
  });

  it("treats empty exclusions identically to omitting them", () => {
    const paragraphs = [para("some text with a bit more length")];
    expect(layoutTranslation(paragraphs, 400, 500, measure, []))
      .toEqual(layoutTranslation(paragraphs, 400, 500, measure));
  });

  it("leaves the flow layout without any x key", () => {
    const layout = layoutTranslation([para("word ".repeat(20))], 500, 300, measure);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(Object.hasOwn(line, "x")).toBe(false);
    }
  });
});

describe("buildExclusionBands", () => {
  it("pads a region by 6px and clamps to padding and footerY", () => {
    expect(buildExclusionBands([region(0.1, 0.2)], 1000, 24, 944)).toEqual([{ top: 94, bottom: 306 }]);
  });

  it("drops regions shorter than 24px in CSS space", () => {
    expect(buildExclusionBands([region(0.1, 0.02)], 1000, 24, 944)).toEqual([]);
  });

  it("sorts and merges overlapping or adjacent regions into one band", () => {
    expect(buildExclusionBands([region(0.3, 0.2), region(0.1, 0.2)], 1000, 24, 944))
      .toEqual([{ top: 94, bottom: 506 }]);
  });

  it("drops a bottom-clipped region whose band collapses", () => {
    expect(buildExclusionBands([region(0.95, 0.1)], 1000, 24, 944)).toEqual([]);
  });

  it("returns no bands for an empty region list", () => {
    expect(buildExclusionBands([], 1000, 24, 944)).toEqual([]);
  });
});

describe("fontString", () => {
  it("composes serif, sans, bold, and monospace stacks", () => {
    expect(fontString("serif", "text", 16)).toBe(`16px ${SERIF_STACK}`);
    expect(fontString("sans", "text", 16)).toBe(`16px ${SANS_STACK}`);
    expect(fontString("serif", "text", 16, 700)).toBe(`bold 16px ${SERIF_STACK}`);
    expect(fontString("serif", "code", 16)).toBe(`16px ${MONOSPACE_STACK}`);
    expect(fontString("sans", "code", 16, 700)).toBe(`bold 16px ${MONOSPACE_STACK}`);
  });
});

describe("anchored translation layout", () => {
  const anchored = (text: string, anchorY: number, fontSizeRatio: number, headingLevel: HeadingLevel = 0, serif: SerifKind = "serif"): StyledParagraph => ({
    text,
    anchorY,
    fontSizeRatio,
    style: { headingLevel, serif, fontWeight: headingLevel > 0 ? 700 : 400 }
  });

  it("locks non-anchored flow output to a fixed deep-equal value", () => {
    const layout = layoutTranslation([para("abc")], 500, 300, measure);
    expect(layout).toEqual({
      fontSize: 20,
      lineHeight: 29,
      paragraphGap: 14,
      padding: 30,
      footerHeight: 32,
      footerY: 238,
      bodyBottom: 59,
      lines: [{
        runs: [{ text: "abc", kind: "text", width: 30 }],
        width: 30,
        y: 30,
        paragraphEnd: true,
        fontSize: 20,
        serif: "serif",
        weight: 400
      }],
      overflow: false
    });
  });

  it("starts heading and body at their own anchors without a heading multiplier", () => {
    const layout = layoutTranslation([
      anchored("Chapter", 0.1, 0.02, 1),
      anchored("Body text", 0.3, 0.012)
    ], 500, 1000, measure);
    const heading = layout.lines[0];
    const body = layout.lines[1];
    expect(heading?.y).toBeCloseTo(100, 6);
    expect(heading?.fontSize).toBe(20);
    expect(heading?.weight).toBe(700);
    expect(body?.y).toBeCloseTo(300, 6);
    expect(body?.fontSize).toBe(12);
    expect(body?.weight).toBe(400);
  });

  it("clamps desired font size to [10, 24] and steps down to 8", () => {
    const big = layoutTranslation([anchored("Tiny", 0, 10)], 500, 1000, measure);
    expect(big.lines[0]?.fontSize).toBe(24);
    const small = layoutTranslation([anchored("Tiny", 0, 0.000001)], 500, 1000, measure);
    expect(small.lines[0]?.fontSize).toBe(10);

    const stepped = layoutTranslation([anchored("x".repeat(2000), 0, 0.012)], 500, 300, measure);
    expect(stepped.lines[0]?.fontSize).toBe(8);
    expect(stepped.overflow).toBe(false);
  });

  it("does not pull up the next heading after a compact block", () => {
    const layout = layoutTranslation([
      anchored("hi", 0.05, 0.01),
      anchored("Chapter", 0.6, 0.02, 1)
    ], 500, 1000, measure);
    expect(layout.lines[1]?.y).toBeCloseTo(600, 6);
  });

  it("shrinks only the overflowing group, not its neighbors", () => {
    const layout = layoutTranslation([
      anchored("x".repeat(650), 0.05, 0.012),
      anchored("ok", 0.2, 0.02)
    ], 500, 1000, measure);
    expect(layout.lines[0]?.fontSize).toBe(11);
    expect(layout.lines.at(-1)?.fontSize).toBe(20);
  });

  it("seals the slot before an image band and pushes a caption below it", () => {
    const regions = [region(0.5, 0.2)];
    const layout = layoutTranslation([
      anchored("Body text here", 0.4, 0.015),
      anchored("Caption", 0.5, 0.01)
    ], 500, 1000, measure, regions);
    const bands = buildExclusionBands(regions, 1000, 0, layout.footerY);
    const body = layout.lines[0];
    const caption = layout.lines[1];
    expect(body?.y).toBeCloseTo(400, 6);
    expect((body?.y ?? 0) + (body?.fontSize ?? 0) * 1.45).toBeLessThanOrEqual(bands[0]?.top ?? Infinity);
    expect(caption?.y).toBeCloseTo(706, 6);
    for (const line of layout.lines) {
      const lineHeight = line.fontSize * 1.45;
      for (const band of bands) {
        expect(line.y >= band.bottom || line.y + lineHeight <= band.top).toBe(true);
      }
    }
  });

  it("treats a 17.2px anchor gap as the validity boundary", () => {
    const make = (gap: number) => layoutTranslation([
      anchored("x".repeat(120), 0.1, 0.01),
      anchored("b", 0.1 + gap / 1000, 0.01)
    ], 500, 1000, measure);
    const below = make(17.1);
    expect(below.overflow).toBe(false);
    expect(below.lines.length).toBeGreaterThanOrEqual(3);
    const at = make(17.2);
    expect(at.overflow).toBe(true);
    expect(at.lines[0]?.runs.map((run) => run.text).join("").endsWith("…")).toBe(true);
    expect(at.lines[1]?.y).toBeCloseTo(117.2, 6);
    const above = make(17.3);
    expect(above.overflow).toBe(true);
    expect(above.lines[1]?.y).toBeCloseTo(117.3, 6);
  });

  it("pushes later columns monotonically downward when anchors overlap", () => {
    const layout = layoutTranslation([
      anchored("Column one", 0.4, 0.02),
      anchored("Column two", 0.41, 0.02),
      anchored("Column three", 0.42, 0.02)
    ], 500, 1000, measure);
    const ys = layout.lines.map((line) => line.y);
    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index]).toBeGreaterThanOrEqual(ys[index - 1] as number);
    }
  });

  it("truncates an overflowing group with an ellipsis that fits the width", () => {
    const layout = layoutTranslation([anchored("x".repeat(600), 0, 0.01)], 500, 100, measure);
    expect(layout.overflow).toBe(true);
    const last = layout.lines.at(-1);
    expect(last).toBeDefined();
    expect(last?.runs.map((run) => run.text).join("").endsWith("…")).toBe(true);
    expect(last?.width).toBeLessThanOrEqual(500 - 2 * layout.padding);
  });

  it("keeps values finite when a zero-line slot hits a band at the footer", () => {
    const layout = layoutTranslation([
      anchored("first", 0.95, 0.02),
      anchored("second", 0.96, 0.02)
    ], 500, 1000, measure, [region(0.9, 0.1)]);
    expect(layout.bodyBottom).toBeLessThanOrEqual(layout.footerY);
    expect(layout.overflow).toBe(true);
    expect(layout.footerText).toBe(TRANSLATION_OVERFLOW_FOOTER);
    expect(Number.isFinite(layout.fontSize)).toBe(true);
    expect(Number.isFinite(layout.bodyBottom)).toBe(true);
    for (const line of layout.lines) {
      expect(Number.isFinite(line.y)).toBe(true);
    }
  });

  it("recovers below the band when the slot can't fit one minimum line", () => {
    const imageRegion = region(0.1634, 0.3268, 0.6717, 0.1515);
    const layout = layoutTranslation([
      anchored("2.2 译文标题", 0.1176, 0.01797, 1, "sans"),
      anchored("2.3 译文标题", 0.1176, 0.01797, 1, "sans"),
      anchored("扩".repeat(3000), 0.1176, 0.01797)
    ], 574, 444, measure, [imageRegion]);

    expect(layout.lines.length).toBeGreaterThan(0);
    const bands = buildExclusionBands([imageRegion], 444, 0, layout.footerY);
    for (const line of layout.lines) {
      const lineHeight = line.fontSize * 1.45;
      for (const band of bands) {
        expect(line.y >= band.bottom - 1e-6 || line.y + lineHeight <= band.top + 1e-6).toBe(true);
      }
    }
    // the second heading's remaining slot is below one minimum line, so it recovers below the band
    expect(layout.lines[1]?.y).toBeGreaterThanOrEqual(223.6 - 1e-6);
    expect(layout.lines[1]?.y).toBeGreaterThan(layout.lines[0]?.y ?? 0);
    expect(layout.overflow).toBe(true);
    expect(Number.isFinite(layout.bodyBottom)).toBe(true);
    expect(layout.bodyBottom).toBeLessThanOrEqual(layout.footerY);
    for (const line of layout.lines) {
      expect(Number.isFinite(line.y)).toBe(true);
    }
  });

  it("recalculates through clamp when the page height changes", () => {
    const small = layoutTranslation([anchored("text", 0.5, 0.02)], 500, 400, measure);
    const large = layoutTranslation([anchored("text", 0.5, 0.02)], 500, 800, measure);
    expect(small.lines[0]?.y).toBeCloseTo(200, 6);
    expect(large.lines[0]?.y).toBeCloseTo(400, 6);
    expect(small.lines[0]?.fontSize).toBe(10);
    expect(large.lines[0]?.fontSize).toBe(16);
  });

  it("jumps below the band only when the remaining slot is below one minimum line", () => {
    const make = (bandTopGap: number) => layoutTranslation(
      [anchored("hi", 0.4, 0.005)],
      500, 1000, measure,
      [region(0.4 + (bandTopGap + 6) / 1000, 0.1)]
    );
    const jump = make(11.5);
    expect(jump.lines[0]?.y).toBeCloseTo(523.5, 6);
    const stay = make(11.7);
    expect(stay.lines[0]?.y).toBeCloseTo(400, 6);
    expect(stay.lines[0]?.fontSize).toBe(8);
  });

  it("starts the next group at the actual bottom without an artificial paragraph gap", () => {
    const layout = layoutTranslation([
      anchored("Column one", 0.4, 0.02),
      anchored("Column two", 0.41, 0.02)
    ], 500, 1000, measure);
    expect(layout.lines[0]?.y).toBeCloseTo(400, 6);
    expect(layout.lines[0]?.fontSize).toBe(20);
    expect(layout.lines[1]?.y).toBeCloseTo(400 + 20 * 1.45, 6);
    expect(layout.lines[1]?.y).toBeGreaterThanOrEqual((layout.lines[0]?.y ?? 0) + (layout.lines[0]?.fontSize ?? 0) * 1.45);
    for (const line of layout.lines) {
      expect(Number.isFinite(line.y)).toBe(true);
    }
  });

  it("centers every line of a centered group", () => {
    const layout = layoutTranslation([
      { ...anchored("word ".repeat(20), 0.1, 0.02), centered: true }
    ], 500, 1000, measure);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(Object.hasOwn(line, "x")).toBe(true);
      expect((line.x ?? 0) + line.width / 2).toBeCloseTo(500 / 2, 6);
    }
  });

  it("recomputes the centered x of an ellipsis line using its final width", () => {
    const layout = layoutTranslation([
      { ...anchored("x".repeat(600), 0, 0.01), centered: true }
    ], 500, 100, measure);
    expect(layout.overflow).toBe(true);
    const last = layout.lines.at(-1);
    expect(last?.runs.map((run) => run.text).join("").endsWith("…")).toBe(true);
    expect(Object.hasOwn(last ?? {}, "x")).toBe(true);
    expect((last?.x ?? 0) + (last?.width ?? 0) / 2).toBeCloseTo(250, 6);
  });

  it("leaves non-centered groups without an own x key", () => {
    const layout = layoutTranslation([anchored("word ".repeat(20), 0.1, 0.02)], 500, 1000, measure);
    expect(layout.lines.length).toBeGreaterThan(1);
    for (const line of layout.lines) {
      expect(Object.hasOwn(line, "x")).toBe(false);
    }
  });

  it("draws from padding without x and from centered x when present", () => {
    const calls: Array<{ text: string; x: number }> = [];
    const rects: Array<{ x: number }> = [];
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: (text: string, x: number) => calls.push({ text, x }),
      fillRect: (x: number) => rects.push({ x }),
      font: "",
      fillStyle: "",
      textBaseline: "",
      strokeStyle: ""
    } as unknown as CanvasRenderingContext2D;

    const flow = layoutTranslation([para("abc")], 500, 300, measure);
    drawTranslationText(context, flow, 500);
    expect(calls[0]?.x).toBe(flow.padding);

    const centered = layoutTranslation([
      { ...anchored("`code`", 0.1, 0.02), centered: true }
    ], 500, 1000, measure);
    calls.length = 0;
    rects.length = 0;
    drawTranslationText(context, centered, 500);
    const line = centered.lines[0];
    expect(line?.x).toBeDefined();
    expect(calls[0]?.x).toBe(line?.x);
    expect(rects[0]?.x).toBe((line?.x ?? 0) - 1);
  });
});
