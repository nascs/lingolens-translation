import { describe, expect, it, vi } from "vitest";
import { resolveTargetLanguage, type LanguageDetectionResult } from "./language";

const detected = (isReliable: boolean, ...languages: Array<[string, number]>): LanguageDetectionResult => ({
  isReliable,
  languages: languages.map(([language, percentage]) => ({ language, percentage }))
});

describe("resolveTargetLanguage", () => {
  it.each([
    [true, "zh-CN", "en", "chinese"],
    [true, "en", "zh-CN", "other"],
    [true, "ja", "zh-CN", "other"],
    [true, "ko", "zh-CN", "other"],
    [false, "cmn", "en", "chinese"],
    [false, "en", "zh-CN", "other"],
    [false, "ja", "zh-CN", "other"],
    [false, "ko", "zh-CN", "other"]
  ] as const)("uses explicit detector result (reliable=%s, language=%s)", async (reliable, language, target, category) => {
    const detector = vi.fn(async () => detected(reliable, ["und", 99], [language, 80]));
    const result = await resolveTargetLanguage("漢字かな한글 English", "smart", detector);
    expect(result).toMatchObject({ detectedLanguage: language, category, resolvedTargetLanguage: target });
  });

  it("chooses the highest-percentage non-und language", async () => {
    const result = await resolveTargetLanguage("text", "smart", async () => detected(true, ["und", 100], ["en", 20], ["zh-TW", 70]));
    expect(result.resolvedTargetLanguage).toBe("en");
  });

  it.each([
    ["短中文", "en", "chinese", "zh"],
    ["漢字かな", "zh-CN", "other", "ja"],
    ["漢字한글", "zh-CN", "other", "ko"],
    ["漢字", "en", "chinese", "zh"],
    ["   ", "zh-CN", "unknown", undefined]
  ] as const)("falls back by script for %j", async (text, target, category, language) => {
    const result = await resolveTargetLanguage(text, "smart", async () => detected(false));
    expect(result).toMatchObject({ category, resolvedTargetLanguage: target, detectedLanguage: language });
  });

  it("falls back after detector errors", async () => {
    const result = await resolveTargetLanguage("かな漢字", "smart", async () => { throw new Error("detector unavailable"); });
    expect(result).toMatchObject({ detectedLanguage: "ja", category: "other", resolvedTargetLanguage: "zh-CN" });
  });

  it("passes manual targets through without calling the detector", async () => {
    const detector = vi.fn(async () => detected(true, ["zh", 100]));
    const result = await resolveTargetLanguage("中文", "fr", detector);
    expect(result).toMatchObject({ category: "unknown", resolvedTargetLanguage: "fr", label: "目标语言：法语" });
    expect(detector).not.toHaveBeenCalled();
  });
});
