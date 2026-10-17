import { describe, expect, it } from "vitest";
import { SANS_STACK, SERIF_STACK, classifyFontFamily, majoritySerif, serifStack } from "./font-classify";

describe("classifyFontFamily", () => {
  it("classifies serif font families", () => {
    expect(classifyFontFamily("Times New Roman")).toBe("serif");
    expect(classifyFontFamily("Georgia")).toBe("serif");
    expect(classifyFontFamily("SimSun")).toBe("serif");
    expect(classifyFontFamily("Cambria")).toBe("serif");
    expect(classifyFontFamily("Noto Serif SC")).toBe("serif");
  });

  it("classifies sans font families", () => {
    expect(classifyFontFamily("Helvetica")).toBe("sans");
    expect(classifyFontFamily("Arial")).toBe("sans");
    expect(classifyFontFamily("Segoe UI")).toBe("sans");
    expect(classifyFontFamily("PingFang SC")).toBe("sans");
  });

  it("treats sans-serif as sans, not serif", () => {
    expect(classifyFontFamily("sans-serif")).toBe("sans");
    expect(classifyFontFamily("serif")).toBe("serif");
  });

  it("normalizes spaces, underscores, and hyphens", () => {
    expect(classifyFontFamily("Times_New_Roman")).toBe("serif");
    expect(classifyFontFamily("Times-New-Roman")).toBe("serif");
    expect(classifyFontFamily("HELVETICA")).toBe("sans");
  });

  it("classifies monospace families as sans", () => {
    expect(classifyFontFamily("Courier New")).toBe("sans");
    expect(classifyFontFamily("Menlo")).toBe("sans");
    expect(classifyFontFamily("Consolas")).toBe("sans");
    expect(classifyFontFamily("DejaVu Sans Mono")).toBe("sans");
  });

  it("does not match bare roman or century", () => {
    expect(classifyFontFamily("Roman")).toBeUndefined();
    expect(classifyFontFamily("Century")).toBeUndefined();
    expect(classifyFontFamily("Century Schoolbook")).toBeUndefined();
    expect(classifyFontFamily("Century Gothic")).toBe("sans");
  });

  it("returns undefined for empty, unknown, or missing families", () => {
    expect(classifyFontFamily(undefined)).toBeUndefined();
    expect(classifyFontFamily("")).toBeUndefined();
    expect(classifyFontFamily("Wingdings")).toBeUndefined();
  });
});

describe("majoritySerif", () => {
  it("resolves ties and empty votes to undefined", () => {
    expect(majoritySerif([])).toBeUndefined();
    expect(majoritySerif([{ serif: undefined, chars: 10 }])).toBeUndefined();
    expect(majoritySerif([{ serif: "serif", chars: 5 }, { serif: "sans", chars: 5 }])).toBeUndefined();
  });

  it("weights votes by character count", () => {
    expect(majoritySerif([{ serif: "serif", chars: 6 }, { serif: "sans", chars: 4 }])).toBe("serif");
    expect(majoritySerif([{ serif: "serif", chars: 1 }, { serif: "sans", chars: 9 }])).toBe("sans");
  });
});

describe("serifStack", () => {
  it("selects the matching stack", () => {
    expect(serifStack("serif")).toBe(SERIF_STACK);
    expect(serifStack("sans")).toBe(SANS_STACK);
  });
});
