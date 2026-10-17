import { describe, expect, it, vi } from "vitest";
import { applyProviderChange, consentAfterBaseUrlChange, requestTransportPermission, showsInsecureHttpRisk } from "./form";

describe("options provider form", () => {
  it("preserves the API key while changing only provider fields", () => {
    const before = {
      apiKey: "placeholder",
      baseUrl: "https://old.example.test/v1",
      model: "old-model",
      allowInsecureHttp: true
    };
    const after = { ...before, ...applyProviderChange(before, "openai") };
    expect(after.apiKey).toBe("placeholder");
    expect(after).toMatchObject({ baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" });
  });

  it("leaves custom fields empty and clears consent", () => {
    expect(applyProviderChange({ baseUrl: "https://api.example.test/v1", model: "example-model", allowInsecureHttp: true }, "custom")).toEqual({
      baseUrl: "",
      model: "",
      allowInsecureHttp: false
    });
  });

  it("shows risk only for valid remote HTTP", () => {
    expect(showsInsecureHttpRisk("http://api.example.test/v1")).toBe(true);
    expect(showsInsecureHttpRisk("https://api.example.test/v1")).toBe(false);
    expect(showsInsecureHttpRisk("http://localhost:8080/v1")).toBe(false);
    expect(showsInsecureHttpRisk("invalid")).toBe(false);
  });

  it("clears consent only when the base URL actually changes", () => {
    expect(consentAfterBaseUrlChange("http://a.test", "http://a.test", true)).toBe(true);
    expect(consentAfterBaseUrlChange("http://a.test", "http://b.test", true)).toBe(false);
  });
});

describe("requestTransportPermission", () => {
  it("requests the exact remote HTTP origin when consent is true", async () => {
    const requester = vi.fn(async () => true);
    await expect(requestTransportPermission({
      baseUrl: "http://api.example.test:8080/v1",
      allowInsecureHttp: true
    }, requester)).resolves.toEqual({ granted: true, origin: "http://api.example.test:8080" });
    expect(requester).toHaveBeenCalledOnce();
    expect(requester).toHaveBeenCalledWith({ origins: ["http://api.example.test:8080/*"] });
  });

  it("rejects unconfirmed remote HTTP before calling the requester", () => {
    const requester = vi.fn(async () => true);
    expect(() => requestTransportPermission({
      baseUrl: "http://api.example.test/v1",
      allowInsecureHttp: false
    }, requester)).toThrow("明文传输");
    expect(requester).not.toHaveBeenCalled();
  });

  it.each([
    "https://api.example.test/v1",
    "http://localhost:8080/v1"
  ])("requests permission for safe transport %s", async (baseUrl) => {
    const requester = vi.fn(async () => true);
    await expect(requestTransportPermission({ baseUrl, allowInsecureHttp: false }, requester)).resolves.toMatchObject({ granted: true });
    expect(requester).toHaveBeenCalledOnce();
  });
});
