import { describe, expect, it } from "vitest";
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  MAX_IMAGE_OPERATOR_LIST,
  MAX_IMAGE_REGIONS_PER_PAGE,
  extractImageRegionsFromOperatorList,
  type PageImageRegion
} from "./document";

interface Viewport {
  width: number;
  height: number;
  transform: readonly number[];
}

const viewport = (width: number, height: number, transform: readonly number[]): Viewport => ({ width, height, transform });

const IDENTITY_VIEWPORT = viewport(100, 100, [1, 0, 0, 1, 0, 0]);

const extract = (fnArray: number[], argsArray: unknown[], vp: Viewport = IDENTITY_VIEWPORT): PageImageRegion[] =>
  extractImageRegionsFromOperatorList(fnArray, argsArray, vp);

// Builds independent save/transform/image/restore groups so each image sees its own CTM.
const imageOps = (images: Array<[number[], string]>): { fnArray: number[]; argsArray: unknown[] } => {
  const fnArray: number[] = [];
  const argsArray: unknown[] = [];
  for (const [matrix, name] of images) {
    fnArray.push(OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore);
    argsArray.push(null, matrix, [name], null);
  }
  return { fnArray, argsArray };
};

describe("extractImageRegionsFromOperatorList", () => {
  it("maps a transformed bitmap to a normalized region through a pure-flip viewport (no manual y-flip)", () => {
    // CTM [50,0,0,50,10,20] places the unit square at user (10,20)..(60,70).
    // viewport transform [1,0,0,-1,0,200] flips y: user y -> 200 - y.
    const regions = extract(
      [OPS.transform, OPS.paintImageXObject],
      [[50, 0, 0, 50, 10, 20], ["Img"]],
      viewport(100, 200, [1, 0, 0, -1, 0, 200])
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]?.x).toBeCloseTo(0.1, 5);
    expect(regions[0]?.y).toBeCloseTo(0.65, 5);
    expect(regions[0]?.width).toBeCloseTo(0.5, 5);
    expect(regions[0]?.height).toBeCloseTo(0.25, 5);
  });

  it("maps through a rotated viewport transform without an extra manual y-flip", () => {
    // viewport transform [0,1,-1,0,100,0] rotates user (x,y) -> (100 - y, x).
    const regions = extract(
      [OPS.transform, OPS.paintImageXObject],
      [[50, 0, 0, 50, 0, 0], ["Img"]],
      viewport(200, 100, [0, 1, -1, 0, 100, 0])
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]?.x).toBeCloseTo(0.25, 5);
    expect(regions[0]?.y).toBeCloseTo(0, 5);
    expect(regions[0]?.width).toBeCloseTo(0.25, 5);
    expect(regions[0]?.height).toBeCloseTo(0.5, 5);
  });

  it("restores the CTM across save/restore and nested transforms", () => {
    const regions = extract(
      [OPS.transform, OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore, OPS.paintImageXObject],
      [[10, 0, 0, 10, 0, 0], null, [5, 0, 0, 5, 0, 0], ["inner"], null, ["outer"]]
    );
    expect(regions).toHaveLength(2);
    // inner image is scaled by 10 * 5 = 50, outer by 10 only.
    expect(regions[0]?.width).toBeCloseTo(0.5, 5);
    expect(regions[1]?.width).toBeCloseTo(0.1, 5);
  });

  it("detects images inside paintFormXObjectBegin/End using args[0] as the form matrix", () => {
    const regions = extract(
      [OPS.paintFormXObjectBegin, OPS.transform, OPS.paintImageXObject, OPS.paintFormXObjectEnd, OPS.paintImageXObject],
      [[[10, 0, 0, 10, 5, 5], null], [2, 0, 0, 2, 0, 0], ["inside"], null, ["outside"]]
    );
    expect(regions).toHaveLength(2);
    expect(regions[0]?.width).toBeCloseTo(0.2, 5);
    expect(regions[0]?.x).toBeCloseTo(0.05, 5);
    expect(regions[1]?.width).toBeCloseTo(0.01, 5);
  });

  it("detects images inside beginGroup/endGroup using args[0].matrix", () => {
    const regions = extract(
      [OPS.beginGroup, OPS.transform, OPS.paintImageXObject, OPS.endGroup, OPS.paintImageXObject],
      [[{ matrix: [10, 0, 0, 10, 5, 5] }], [2, 0, 0, 2, 0, 0], ["inside"], null, ["outside"]]
    );
    expect(regions).toHaveLength(2);
    expect(regions[0]?.width).toBeCloseTo(0.2, 5);
    expect(regions[1]?.width).toBeCloseTo(0.01, 5);
  });

  it("collects inline images and ignores mask, repeat, and other ops", () => {
    const regions = extract(
      [
        OPS.paintImageXObject,
        OPS.paintInlineImageXObject,
        OPS.paintImageMaskXObject,
        OPS.paintImageXObjectRepeat,
        OPS.paintSolidColorImageMask,
        OPS.constructPath
      ],
      [["a"], ["b"], ["mask"], ["repeat"], ["solid"], null]
    );
    expect(regions).toHaveLength(2);
    expect(regions.every((region) => region.width > 0 && region.height > 0)).toBe(true);
  });

  it("skips degenerate (edge <= 0.004) and near-full-page (>= 0.9) regions", () => {
    const { fnArray, argsArray } = imageOps([
      [[0.3, 0, 0, 10, 0, 0], "degenerate-width"],
      [[10, 0, 0, 0.3, 0, 0], "degenerate-height"],
      [[95, 0, 0, 95, 0, 0], "near-full-page"],
      [[10, 0, 0, 10, 0, 0], "normal"]
    ]);
    const regions = extract(fnArray, argsArray);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.width).toBeCloseTo(0.1, 5);
    expect(regions[0]?.height).toBeCloseTo(0.1, 5);
  });

  it("truncates to the largest 60 regions by area in descending order", () => {
    const images: Array<[number[], string]> = [];
    for (let scale = 1; scale <= MAX_IMAGE_REGIONS_PER_PAGE + 1; scale += 1) {
      images.push([[scale, 0, 0, scale, 0, 0], `img${scale}`]);
    }
    const { fnArray, argsArray } = imageOps(images);
    const regions = extract(fnArray, argsArray);
    expect(regions).toHaveLength(MAX_IMAGE_REGIONS_PER_PAGE);
    expect(regions[0]?.width).toBeCloseTo((MAX_IMAGE_REGIONS_PER_PAGE + 1) / 100, 5);
    expect(regions.at(-1)?.width).toBeCloseTo(2 / 100, 5);
  });

  it("returns no regions when the operator list exceeds the limit", () => {
    const fnArray = new Array<number>(MAX_IMAGE_OPERATOR_LIST + 1).fill(OPS.save);
    const argsArray = new Array<unknown>(MAX_IMAGE_OPERATOR_LIST + 1).fill(null);
    expect(extract(fnArray, argsArray)).toEqual([]);
  });

  it("produces scale-invariant normalized regions across viewport sizes", () => {
    const fnArray = [OPS.transform, OPS.paintImageXObject];
    const argsArray = [[50, 0, 0, 50, 10, 20], ["Img"]];
    const small = extract(fnArray, argsArray, viewport(100, 100, [1, 0, 0, 1, 0, 0]));
    const large = extract(fnArray, argsArray, viewport(1000, 1000, [10, 0, 0, 10, 0, 0]));
    expect(small).toEqual(large);
    expect(small[0]?.x).toBeCloseTo(0.1, 5);
    expect(small[0]?.y).toBeCloseTo(0.2, 5);
    expect(small[0]?.width).toBeCloseTo(0.5, 5);
    expect(small[0]?.height).toBeCloseTo(0.5, 5);
  });
});
