import { describe, expect, it } from "vitest";
import { reconstructParagraphShapes, type PdfTextItem } from "./text";

function item(str: string, x: number, y: number, options: Partial<PdfTextItem> = {}): PdfTextItem {
  return { str, transform: [1, 0, 0, 12, x, y], width: str.length * 6, height: 12, hasEOL: false, ...options };
}

describe("reconstructParagraphs", () => {
  it("joins positioned items on the same line", () => {
    expect(reconstructParagraphShapes([item("Hello", 0, 100), item("world", 40, 100)], () => undefined).map((shape) => shape.text)).toEqual(["Hello world"]);
  });

  it("uses hasEOL and joins normal lines into one paragraph", () => {
    expect(reconstructParagraphShapes([
      item("A stable", 0, 100, { hasEOL: true }),
      item("paragraph.", 0, 86)
    ], () => undefined).map((shape) => shape.text)).toEqual(["A stable paragraph."]);
  });

  it("splits paragraphs at a large vertical gap", () => {
    expect(reconstructParagraphShapes([
      item("First paragraph.", 0, 100, { hasEOL: true }),
      item("Second paragraph.", 0, 60)
    ], () => undefined).map((shape) => shape.text)).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("preserves content order when a second column restarts at the top", () => {
    expect(reconstructParagraphShapes([
      item("Left one.", 0, 100, { hasEOL: true }),
      item("Left two.", 0, 84, { hasEOL: true }),
      item("Right one.", 300, 100, { hasEOL: true }),
      item("Right two.", 300, 84)
    ], () => undefined).map((shape) => shape.text)).toEqual(["Left one. Left two.", "Right one. Right two."]);
  });

  it("joins CJK lines without inserting an artificial space", () => {
    expect(reconstructParagraphShapes([item("这是", 0, 100, { hasEOL: true }), item("中文", 0, 86)], () => undefined).map((shape) => shape.text)).toEqual(["这是中文"]);
  });

  it("returns no paragraphs for an empty text layer", () => {
    expect(reconstructParagraphShapes([], () => undefined).map((shape) => shape.text)).toEqual([]);
    expect(reconstructParagraphShapes([item("   ", 0, 100)], () => undefined).map((shape) => shape.text)).toEqual([]);
  });
});

describe("reconstructParagraphShapes", () => {
  const resolve = (fontName?: string) => fontName === "serif" ? "serif" as const : fontName === "sans" ? "sans" as const : undefined;

  it("computes per-paragraph font size as the char-weighted median of line heights", () => {
    const shapes = reconstructParagraphShapes([
      item("ab", 0, 100, { hasEOL: true, height: 20 }),
      item("cdefghij", 0, 86, { height: 10 })
    ], () => undefined);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.fontSize).toBe(10);
    expect(shapes[0]?.charCount).toBe(11);
    expect(shapes[0]?.lineCount).toBe(2);
  });

  it("votes line serif by item string length", () => {
    const shapes = reconstructParagraphShapes([
      item("AAAA", 0, 100, { fontName: "serif" }),
      item("b", 40, 100, { fontName: "sans" })
    ], resolve);
    expect(shapes[0]?.serif).toBe("serif");
  });

  it("resolves a line serif tie to undefined", () => {
    const shapes = reconstructParagraphShapes([
      item("AA", 0, 100, { fontName: "serif" }),
      item("bb", 40, 100, { fontName: "sans" })
    ], resolve);
    expect(shapes[0]?.serif).toBeUndefined();
  });

  it("votes paragraph serif by weighted line length", () => {
    const shapes = reconstructParagraphShapes([
      item("SERIF", 0, 100, { hasEOL: true, fontName: "serif" }),
      item("s", 0, 86, { fontName: "sans" })
    ], resolve);
    expect(shapes[0]?.serif).toBe("serif");
  });

  it("returns undefined serif when no item carries font information", () => {
    const shapes = reconstructParagraphShapes([item("text", 0, 100)], resolve);
    expect(shapes[0]?.serif).toBeUndefined();
  });
});

describe("paragraph geometry anchoring", () => {
  const viewport = (width: number, height: number, transform: readonly number[], isUnsafeFont?: (fontName?: string) => boolean) => ({
    viewport: { width, height, transform },
    isUnsafeFont
  });
  const noSerif = () => undefined;
  const boxItem = (): PdfTextItem => ({ str: "T", transform: [1, 0, 0, 12, 40, 100], width: 200, height: 12, hasEOL: false });

  it("maps each page rotation onto normalized topY/bottomY", () => {
    const cases = [
      { width: 600, height: 800, transform: [1, 0, 0, 1, 0, 0], topY: 100 / 800, bottomY: 112 / 800 },
      { width: 800, height: 600, transform: [0, 1, -1, 0, 600, 0], topY: 40 / 600, bottomY: 240 / 600 },
      { width: 600, height: 800, transform: [-1, 0, 0, -1, 600, 800], topY: 688 / 800, bottomY: 700 / 800 },
      { width: 800, height: 600, transform: [0, -1, 1, 0, 0, 600], topY: 360 / 600, bottomY: 560 / 600 }
    ];
    for (const c of cases) {
      const [shape] = reconstructParagraphShapes([boxItem()], noSerif, viewport(c.width, c.height, c.transform));
      expect(shape?.topY).toBeCloseTo(c.topY, 6);
      expect(shape?.bottomY).toBeCloseTo(c.bottomY, 6);
      expect(shape?.topY).toBeGreaterThanOrEqual(0);
      expect(shape?.bottomY).toBeLessThanOrEqual(1);
      expect(shape?.topY).toBeLessThanOrEqual(shape?.bottomY as number);
    }
  });

  it("drops all geometry when any item is rotated, slanted, or sheared", () => {
    const good = item("Good", 0, 100, { hasEOL: true });
    const badTransforms = [
      [0, 1, -1, 0, 0, 50],
      [Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12), 0, 50],
      [1, 0, 0.5, 1, 0, 50]
    ];
    for (const transform of badTransforms) {
      const bad: PdfTextItem = { str: "Bad", transform, width: 6, height: 12, hasEOL: false };
      const shapes = reconstructParagraphShapes([good, bad], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0]));
      for (const shape of shapes) {
        expect(shape.topY).toBeUndefined();
        expect(shape.bottomY).toBeUndefined();
        expect(shape.fontSizeRatio).toBeUndefined();
        expect(shape.centered).toBeUndefined();
      }
    }
  });

  it("accepts a 1e-3 slanted item but rejects anything larger", () => {
    const safe = reconstructParagraphShapes(
      [item("T", 0, 100, { transform: [1, 0.001, 0, 1, 0, 100] })],
      noSerif,
      viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(safe[0]?.topY).toBeCloseTo(100 / 800, 6);
    const unsafe = reconstructParagraphShapes(
      [item("T", 0, 100, { transform: [1, 0.0011, 0, 1, 0, 100] })],
      noSerif,
      viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(unsafe[0]?.topY).toBeUndefined();
    expect(unsafe[0]?.fontSizeRatio).toBeUndefined();
  });

  it("computes fontSizeRatio from a UserUnit-scaled viewport", () => {
    const shapes = reconstructParagraphShapes(
      [item("T", 0, 100, { transform: [1, 0, 0, 8, 0, 100], height: 8 })],
      noSerif,
      viewport(400, 400, [2, 0, 0, 2, 0, 0])
    );
    expect(shapes[0]?.fontSizeRatio).toBeCloseTo((8 * 2) / 400, 10);
    expect(shapes[0]?.fontSizeRatio).toBeCloseTo(0.04, 10);
  });

  it("keeps anchor geometry invariant under viewport scaling", () => {
    const base = reconstructParagraphShapes([boxItem()], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0]));
    const scaled = reconstructParagraphShapes([boxItem()], noSerif, viewport(300, 400, [0.5, 0, 0, 0.5, 0, 0]));
    expect(scaled[0]?.topY).toBeCloseTo(base[0]?.topY as number, 10);
    expect(scaled[0]?.bottomY).toBeCloseTo(base[0]?.bottomY as number, 10);
    expect(scaled[0]?.fontSizeRatio).toBeCloseTo(base[0]?.fontSizeRatio as number, 10);
  });

  it("omits geometry keys entirely when no geometry is supplied", () => {
    const [shape] = reconstructParagraphShapes([boxItem()], noSerif);
    expect(shape).toBeDefined();
    expect(shape).not.toHaveProperty("topY");
    expect(shape).not.toHaveProperty("bottomY");
    expect(shape).not.toHaveProperty("fontSizeRatio");
  });

  it("falls back for a whole page when a vertical font is present", () => {
    const shapes = reconstructParagraphShapes(
      [item("Vertical", 0, 100, { fontName: "V1" })],
      noSerif,
      viewport(600, 800, [1, 0, 0, 1, 0, 0], (fontName) => fontName === "V1")
    );
    expect(shapes[0]?.topY).toBeUndefined();
    expect(shapes[0]?.bottomY).toBeUndefined();
    expect(shapes[0]?.fontSizeRatio).toBeUndefined();
  });
});

describe("paragraph centering detection", () => {
  const viewport = (width: number, height: number, transform: readonly number[]) => ({
    viewport: { width, height, transform }
  });
  const noSerif = () => undefined;
  const line = (x: number, width: number, y: number, hasEOL = false): PdfTextItem => ({
    str: "L", transform: [1, 0, 0, 12, x, y], width, height: 12, hasEOL
  });

  it("rejects a single line with a 72pt left margin spanning 0.72W", () => {
    const [shape] = reconstructParagraphShapes(
      [line(72, 432, 100)], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(shape?.centered).toBeUndefined();
  });

  it("rejects a symmetric near-full single line spanning 0.758W", () => {
    const [shape] = reconstructParagraphShapes(
      [line(72, 454.8, 100)], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(shape?.centered).toBeUndefined();
  });

  it("accepts a multi-line 0.72W centered paragraph", () => {
    const [shape] = reconstructParagraphShapes(
      [line(84, 432, 100, true), line(84, 432, 86)], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(shape?.centered).toBe(true);
  });

  it("accepts a centered wide first line via the multi-line spread branch", () => {
    const [shape] = reconstructParagraphShapes(
      [line(30, 540, 100, true), line(42, 516, 86)], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(shape?.centered).toBe(true);
  });

  it("gates the multi-line spread branch on both sides of 0.02W", () => {
    // spread = 0.019W < 0.02W: rejected even though the widest line exceeds 0.75W
    const narrow = reconstructParagraphShapes(
      [line(30, 540, 100, true), line(41.4, 517.2, 86)], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(narrow[0]?.centered).toBeUndefined();

    // spread = 0.02W exactly: accepted at the boundary
    const boundary = reconstructParagraphShapes(
      [line(30, 540, 100, true), line(18, 564, 86)], noSerif, viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(boundary[0]?.centered).toBe(true);
  });

  it("keeps the anchor but skips centered for rotated or slanted viewports", () => {
    const transforms: ReadonlyArray<readonly number[]> = [
      [0, 1, -1, 0, 600, 0],
      [Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), -Math.sin(Math.PI / 12), Math.cos(Math.PI / 12), 0, 0]
    ];
    for (const transform of transforms) {
      const [shape] = reconstructParagraphShapes(
        [line(84, 432, 100)], noSerif, viewport(600, 800, transform)
      );
      expect(shape?.topY).toBeDefined();
      expect(shape?.centered).toBeUndefined();
    }
  });

  it("treats a non-finite mapped x as not centered", () => {
    const [shape] = reconstructParagraphShapes(
      [{ str: "L", transform: [1, 0, 0, 12, 72, 100], width: Infinity, height: 12, hasEOL: false }],
      noSerif,
      viewport(600, 800, [1, 0, 0, 1, 0, 0])
    );
    expect(shape?.centered).toBeUndefined();
  });
});
