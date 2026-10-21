import { describe, expect, it } from "vitest";
import { fitWithin, isImageDataUrl, isSupportedImageType, languageName } from "./image";

describe("fitWithin", () => {
  it("keeps images that already fit", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("scales the longest edge and preserves the aspect ratio", () => {
    expect(fitWithin(3200, 1600)).toEqual({ width: 1600, height: 800 });
    expect(fitWithin(1200, 3200)).toEqual({ width: 600, height: 1600 });
  });

  it("never produces a zero dimension", () => {
    expect(fitWithin(10000, 3)).toEqual({ width: 1600, height: 1 });
  });

  it.each([[0, 10], [10, 0], [Number.NaN, 10]])("rejects invalid dimensions %s x %s", (width, height) => {
    expect(() => fitWithin(width, height)).toThrow("图片尺寸无效");
  });
});

describe("image formats", () => {
  it.each(["image/png", "image/jpeg", "image/webp"])("accepts %s", (type) => {
    expect(isSupportedImageType(type)).toBe(true);
  });

  it.each(["image/gif", "image/svg+xml", "text/plain"])("rejects %s", (type) => {
    expect(isSupportedImageType(type)).toBe(false);
  });

  it("accepts a base64 data URL", () => {
    expect(isImageDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe(true);
  });

  it.each([
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:text/plain;base64,aGVsbG8=",
    "https://example.test/image.png",
    "data:image/png;base64,not base64!"
  ])("rejects %s", (value) => {
    expect(isImageDataUrl(value)).toBe(false);
  });
});

describe("languageName", () => {
  it("maps known codes and passes through unknown ones", () => {
    expect(languageName("zh-CN")).toBe("Simplified Chinese");
    expect(languageName("ko")).toBe("Korean");
    expect(languageName("pt-BR")).toBe("pt-BR");
  });
});
