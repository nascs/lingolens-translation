import { afterEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../shared/config";
import {
  buildImagePrompt,
  buildSystemPrompt,
  isVisionUnsupportedError,
  looksLikeVisionRefusal,
  parseImageTranslationContent,
  parseImageTranslationResponse,
  parseTranslationResponse,
  translateBatch,
  translateImage,
  TranslationApiError,
  visionUnsupportedMessage
} from "./api";

const settings: Settings = {
  provider: "deepseek",
  apiKey: "placeholder",
  baseUrl: "https://api.example.test",
  model: "test-model",
  imageModel: "",
  allowInsecureHttp: false,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  translationStyle: "subtle",
  translateDynamicContent: true,
  showSelectionButton: true,
  displayMode: "bilingual",
  glossary: ""
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const successfulResponse = () => new Response(JSON.stringify({
  choices: [{ message: { content: '{"translations":[{"id":"a","text":"ok"}]}' } }]
}), { status: 200 });

describe("parseTranslationResponse", () => {
  it("parses fenced JSON and preserves requested ids", () => {
    const raw = { choices: [{ message: { content: "```json\n{\"translations\":[{\"id\":\"a\",\"text\":\"你好\"}]}\n```" } }] };
    expect(parseTranslationResponse(raw, ["a"])).toEqual([{ id: "a", text: "你好" }]);
  });

  it("rejects incomplete batches", () => {
    const raw = { choices: [{ message: { content: '{"translations":[]}' } }] };
    expect(() => parseTranslationResponse(raw, ["a"])).toThrow(TranslationApiError);
  });
});

describe("translateBatch cancellation", () => {
  it("forwards an external abort to an internal fetch signal and never retries", async () => {
    const controller = new AbortController();
    let internalSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      internalSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN", controller.signal);
    await Promise.resolve();
    expect(internalSignal).toBeDefined();
    expect(internalSignal).not.toBe(controller.signal);
    controller.abort();
    expect(internalSignal?.aborted).toBe(true);
    await expect(request).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts immediately during retry backoff", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN", controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("translateBatch retries and timeouts", () => {
  it.each([429, 500, 503])("retries status %i three times then fails without a trailing wait", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("busy", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    const expectation = expect(request).rejects.toMatchObject({ code: "API_ERROR", status });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(1400);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries twice then succeeds and leaves no timers", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) return new Response("busy", { status: 429 });
      return successfulResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(1400);
    await expect(request).resolves.toEqual([{ id: "a", text: "ok" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails immediately on a non-retryable 4xx", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    const expectation = expect(request).rejects.toMatchObject({ code: "API_ERROR", status: 400 });
    await vi.advanceTimersByTimeAsync(0);
    await expectation;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("times out three hanging fetches and reports a timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    const expectation = expect(request).rejects.toMatchObject({ code: "NETWORK_ERROR", message: "请求超时" });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(700);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(1400);
    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a hanging response body then retries successfully", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => new Promise<string>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          })
        } as Response);
      }
      return Promise.resolve(successfulResponse());
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(700);
    await expect(request).resolves.toEqual([{ id: "a", text: "ok" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the second attempt after the first times out", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return Promise.resolve(successfulResponse());
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(700);
    await expect(request).resolves.toEqual([{ id: "a", text: "ok" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cleans up timers after a successful request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => successfulResponse());
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    await vi.advanceTimersByTimeAsync(0);
    await expect(request).resolves.toEqual([{ id: "a", text: "ok" }]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("translateBatch transport validation", () => {
  it("rejects remote HTTP without consent before fetch and does not reflect the key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = translateBatch({ ...settings, baseUrl: "http://api.example.test/v1", allowInsecureHttp: false }, [{ id: "a", text: "hello" }], "en", "zh-CN");
    await expect(request).rejects.toThrow("明文传输");
    expect(fetchMock).not.toHaveBeenCalled();
    try { await request; } catch (error) { expect(String(error)).not.toContain("placeholder"); }
  });

  it.each([
    ["http://api.example.test/v1", true],
    ["https://api.example.test/v1", false],
    ["http://localhost:8080/v1", false]
  ] as const)("allows approved transport %s", async (baseUrl, allowInsecureHttp) => {
    const fetchMock = vi.fn(async () => successfulResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateBatch({ ...settings, baseUrl, allowInsecureHttp }, [{ id: "a", text: "hello" }], "en", "zh-CN")).resolves.toEqual([{ id: "a", text: "ok" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not reflect the API key from provider error bodies", async () => {
    expect.assertions(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "placeholder rejected" } }), { status: 400 })));
    try {
      await translateBatch(settings, [{ id: "a", text: "hello" }], "en", "zh-CN");
    } catch (error) {
      expect(String(error)).not.toContain("placeholder");
    }
  });
});

describe("buildSystemPrompt", () => {
  it("omits terminology when the glossary is empty", () => {
    const prompt = buildSystemPrompt(settings, "en", "zh-CN");
    expect(prompt).toContain("professional translator");
    expect(prompt).not.toContain("Fixed terminology");
    expect(prompt).toContain("Return only JSON");
  });

  it("injects fixed terminology entries", () => {
    const prompt = buildSystemPrompt({ ...settings, glossary: "board=板卡\nkernel=内核" }, "en", "zh-CN");
    expect(prompt).toContain("Fixed terminology");
    expect(prompt).toContain("board => 板卡");
    expect(prompt).toContain("kernel => 内核");
  });

  it("caps the injected glossary length", () => {
    const glossary = Array.from({ length: 100 }, (_, index) => `term${index}=${"译".repeat(30)}`).join("\n");
    const prompt = buildSystemPrompt({ ...settings, glossary }, "en", "zh-CN");
    const injected = prompt.slice(prompt.indexOf("Fixed terminology"), prompt.indexOf("Return only JSON"));
    expect(injected.length).toBeLessThan(2200);
  });
});

const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

function imageResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
}

describe("image prompt and parsing", () => {
  it("asks for both transcription and translation", () => {
    const prompt = buildImagePrompt(settings, "auto", "zh-CN");
    expect(prompt).toContain("Translate from the detected source language to Simplified Chinese");
    expect(prompt).toContain("[原文]");
    expect(prompt).toContain("[译文]");
  });

  it("injects the glossary into the image prompt", () => {
    const prompt = buildImagePrompt({ ...settings, glossary: "board=板卡" }, "ko", "zh-CN");
    expect(prompt).toContain("board => 板卡");
  });

  it("splits the two sections", () => {
    expect(parseImageTranslationContent("[原文]\n안녕하세요\n[译文]\n你好")).toEqual({
      sourceText: "안녕하세요",
      translatedText: "你好"
    });
  });

  it("strips a code fence and tolerates a missing source marker", () => {
    expect(parseImageTranslationContent("```\n[译文]\n你好\n```")).toEqual({ sourceText: "", translatedText: "你好" });
  });

  it("falls back to treating the whole reply as the translation", () => {
    expect(parseImageTranslationContent("图片里写着你好")).toEqual({ sourceText: "", translatedText: "图片里写着你好" });
  });

  it("reads array-shaped content parts", () => {
    const raw = { choices: [{ message: { content: [{ type: "text", text: "[原文]\na\n" }, { type: "text", text: "[译文]\nb" }] } }] };
    expect(parseImageTranslationResponse(raw)).toEqual({ sourceText: "a", translatedText: "b" });
  });
});

describe("vision capability detection", () => {
  it.each([
    [400, "unknown variant `image_url`, expected `text`"],
    [400, "Invalid content type. image_url is only supported by certain models."],
    [422, "messages.content must be a string"],
    [400, "当前模型不支持图片输入"]
  ] as const)("maps status %i with %s to an unsupported-model error", (status, message) => {
    expect(isVisionUnsupportedError(status, message)).toBe(true);
  });

  it("does not blame vision for unrelated errors", () => {
    expect(isVisionUnsupportedError(400, "Invalid API key")).toBe(false);
    expect(isVisionUnsupportedError(404, "The model does not exist")).toBe(false);
    expect(isVisionUnsupportedError(500, "image backend unavailable")).toBe(false);
    expect(isVisionUnsupportedError(400, "image exceeds maximum size")).toBe(false);
    expect(isVisionUnsupportedError(400, "image format not supported")).toBe(false);
  });

  it("recognizes refusals without matching 'cannot see any text in the image'", () => {
    expect(looksLikeVisionRefusal("I cannot see the image.")).toBe(true);
    expect(looksLikeVisionRefusal("看不到图片")).toBe(true);
    expect(looksLikeVisionRefusal("I cannot see any text in the image.")).toBe(false);
  });

  it("names the configured model in the guidance", () => {
    expect(visionUnsupportedMessage("deepseek-chat")).toContain("deepseek-chat");
    expect(visionUnsupportedMessage("deepseek-chat")).toContain("图片模型");
  });
});

describe("translateImage", () => {
  it("uses the image model and sends a multimodal message", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => imageResponse("[原文]\n안녕\n[译文]\n你好"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateImage({ ...settings, imageModel: "vision-model" }, imageDataUrl, "ko", "zh-CN");
    expect(result).toEqual({ sourceText: "안녕", translatedText: "你好", model: "vision-model" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("vision-model");
    expect(body.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: imageDataUrl } });
  });

  it("falls back to the main model when no image model is set", async () => {
    const fetchMock = vi.fn(async () => imageResponse("[译文]\n你好"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateImage(settings, imageDataUrl, "auto", "zh-CN");
    expect(result.model).toBe("test-model");
  });

  it("rejects a malformed image before calling the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(translateImage(settings, "data:image/svg+xml;base64,PHN2Zz4=", "auto", "zh-CN"))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns a provider capability error into actionable guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "unknown variant `image_url`, expected `text`" }
    }), { status: 400 })));
    await expect(translateImage(settings, imageDataUrl, "ko", "zh-CN")).rejects.toMatchObject({
      code: "VISION_UNSUPPORTED",
      message: expect.stringContaining("图片模型")
    });
  });

  it("flags a model that answers as if it cannot see images", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("I cannot see the image you mentioned.")));
    await expect(translateImage(settings, imageDataUrl, "ko", "zh-CN")).rejects.toMatchObject({ code: "VISION_UNSUPPORTED" });
  });
});
