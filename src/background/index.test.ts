import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "../shared/config";
import type { BackgroundRequest } from "../shared/messages";

const localGet = vi.fn(async (): Promise<unknown> => ({}));
const fetchMock = vi.fn();
let handleMessage: (message: BackgroundRequest, sender: chrome.runtime.MessageSender) => Promise<unknown>;

const remoteHttpSettings: Settings = {
  provider: "custom",
  apiKey: "placeholder",
  baseUrl: "http://api.example.test/v1",
  model: "example-model",
  allowInsecureHttp: false,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  translationStyle: "subtle",
  translateDynamicContent: true,
  showSelectionButton: true,
  displayMode: "bilingual",
  glossary: ""
};

beforeAll(async () => {
  const event = { addListener: vi.fn() };
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "extension-id",
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      onMessage: event,
      onInstalled: event,
      openOptionsPage: vi.fn()
    },
    storage: {
      local: { get: localGet, set: vi.fn() },
      session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() }
    },
    permissions: { contains: vi.fn() },
    extension: { isAllowedFileSchemeAccess: vi.fn() },
    tabs: {
      query: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      sendMessage: vi.fn(),
      onRemoved: event,
      onUpdated: event
    },
    scripting: { insertCSS: vi.fn(), executeScript: vi.fn() },
    contextMenus: { create: vi.fn(), onClicked: event },
    commands: { onCommand: event }
  });
  ({ handleMessage } = await import("./index"));
});

beforeEach(() => {
  localGet.mockReset();
  fetchMock.mockClear();
});

describe("background transport entry points", () => {
  const sender = { id: "extension-id", url: "chrome-extension://extension-id/options.html" } as chrome.runtime.MessageSender;

  it("blocks provider tests before fetch", async () => {
    await expect(handleMessage({ type: "TEST_PROVIDER", settings: remoteHttpSettings }, sender)).rejects.toThrow("明文传输");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks stored translation settings before cache or fetch", async () => {
    localGet.mockResolvedValue(remoteHttpSettings);
    await expect(handleMessage({
      type: "TRANSLATE_BATCH",
      items: [{ id: "a", text: "hello" }],
      sourceLanguage: "en",
      targetLanguage: "zh-CN"
    }, sender)).rejects.toThrow("明文传输");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
