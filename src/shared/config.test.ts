import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  MAX_GLOSSARY_ENTRIES,
  defaultsForProvider,
  loadSettings,
  normalizeDisplayMode,
  normalizeSettings,
  parseGlossary,
  permissionPatternForBaseUrl,
  saveSettings,
  validateTransport
} from "./config";

afterEach(() => vi.unstubAllGlobals());

describe("validateTransport", () => {
  it.each([
    ["https://api.example.test/v1", false],
    ["http://localhost:8080/v1", false],
    ["http://127.0.0.1:8080/v1", false],
    ["http://[::1]:8080/v1", false],
    ["http://api.example.test/v1", true]
  ] as const)("accepts %s with consent=%s", (baseUrl, consent) => {
    expect(validateTransport(baseUrl, consent).normalizedUrl).toBe(baseUrl);
  });

  it("rejects remote HTTP without explicit consent, including a missing field", () => {
    expect(() => validateTransport("http://api.example.test/v1", false)).toThrow("明文传输");
    expect(() => validateTransport("http://api.example.test/v1")).toThrow("明文传输");
  });

  it.each([
    "ftp://api.example.test/v1",
    "not a URL"
  ])("rejects invalid transport %s", (baseUrl) => {
    expect(() => validateTransport(baseUrl, true)).toThrow();
  });

  it("rejects embedded URL credentials", () => {
    const credentialUrl = new URL("https://api.example.test/v1");
    credentialUrl.username = "user";
    credentialUrl.password = "password";
    expect(() => validateTransport(credentialUrl.href, true)).toThrow("无凭据");
  });

  it("returns the normalized origin permission pattern", () => {
    expect(validateTransport("https://api.example.test:8443/v1").origin).toBe("https://api.example.test:8443");
    expect(permissionPatternForBaseUrl("https://api.example.test:8443/v1")).toBe("https://api.example.test:8443/*");
    expect(permissionPatternForBaseUrl("http://api.example.test/v1", true)).toBe("http://api.example.test/*");
  });
});

describe("settings normalization", () => {
  it("leaves the custom provider empty for the user to configure", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      provider: "custom",
      baseUrl: "",
      model: "",
      apiKey: "",
      allowInsecureHttp: false
    });
    expect(defaultsForProvider("custom")).toEqual({ baseUrl: "", model: "" });
  });

  it("preserves legacy provider fields and defaults missing consent to false", () => {
    expect(normalizeSettings({
      provider: "deepseek",
      baseUrl: "https://legacy.example.test/v1/",
      model: "legacy-model",
      apiKey: "placeholder"
    })).toMatchObject({
      provider: "deepseek",
      baseUrl: "https://legacy.example.test/v1",
      model: "legacy-model",
      apiKey: "placeholder",
      allowInsecureHttp: false
    });
  });

  it("preserves an explicit consent value", () => {
    expect(normalizeSettings({ allowInsecureHttp: true }).allowInsecureHttp).toBe(true);
  });

  it("does not write unconfirmed remote HTTP settings", async () => {
    const set = vi.fn();
    vi.stubGlobal("chrome", { storage: { local: { set } } });
    await expect(saveSettings({ ...DEFAULT_SETTINGS, baseUrl: "http://api.example.test/v1", model: "example-model" })).rejects.toThrow("明文传输");
    expect(set).not.toHaveBeenCalled();
  });
});

describe("display mode", () => {
  it("defaults to bilingual and accepts known modes", () => {
    expect(normalizeDisplayMode(undefined)).toBe("bilingual");
    expect(normalizeDisplayMode("bilingual")).toBe("bilingual");
    expect(normalizeDisplayMode("translation")).toBe("translation");
    expect(normalizeDisplayMode("hover")).toBe("hover");
    expect(normalizeDisplayMode("other")).toBe("bilingual");
  });

  it("normalizes new settings fields", () => {
    expect(normalizeSettings({})).toMatchObject({ displayMode: "bilingual", glossary: "" });
    expect(normalizeSettings({ displayMode: "hover", glossary: "board=板卡" }))
      .toMatchObject({ displayMode: "hover", glossary: "board=板卡" });
    expect(normalizeSettings({ displayMode: "bogus", glossary: 42 }))
      .toMatchObject({ displayMode: "bilingual", glossary: "" });
  });
});

describe("parseGlossary", () => {
  it("parses lines, trims, and skips comments, blanks, and malformed entries", () => {
    const raw = ["# comment", "", "board = 板卡", "kernel=内核", "no-separator", "=value", "key=", "a=b=c"].join("\n");
    expect(parseGlossary(raw)).toEqual([
      { from: "board", to: "板卡" },
      { from: "kernel", to: "内核" },
      { from: "a", to: "b=c" }
    ]);
  });

  it("skips overlong terms and caps entries", () => {
    const long = "x".repeat(61);
    expect(parseGlossary(`${long}=value`)).toEqual([]);
    expect(parseGlossary(`ok=${long}`)).toEqual([]);
    const raw = Array.from({ length: MAX_GLOSSARY_ENTRIES + 5 }, (_, index) => `k${index}=v${index}`).join("\n");
    expect(parseGlossary(raw)).toHaveLength(MAX_GLOSSARY_ENTRIES);
  });

  it("returns an empty list for empty input", () => {
    expect(parseGlossary("")).toEqual([]);
  });
});

describe("image model", () => {
  it("defaults to empty, meaning the text model is reused", () => {
    expect(DEFAULT_SETTINGS.imageModel).toBe("");
    expect(normalizeSettings({})).toMatchObject({ imageModel: "" });
  });

  it("trims an explicitly configured image model", () => {
    expect(normalizeSettings({ imageModel: "  vision-model  " }).imageModel).toBe("vision-model");
  });

  it("loads the image model from storage", async () => {
    const get = vi.fn(async (_keys?: string | string[]) => ({ model: "text-model", imageModel: "vision-model" }));
    vi.stubGlobal("chrome", { storage: { local: { get, set: vi.fn() } } });
    await expect(loadSettings()).resolves.toMatchObject({ imageModel: "vision-model" });
    expect(get.mock.calls[0]?.[0]).toContain("imageModel");
  });
});
