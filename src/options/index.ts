import "./styles.css";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeDisplayMode,
  saveSettings,
  type DisplayMode,
  type Provider,
  type Settings,
  type TranslationStyle
} from "../shared/config";
import type { Response } from "../shared/messages";
import { applyProviderChange, consentAfterBaseUrlChange, requestTransportPermission, showsInsecureHttpRisk } from "./form";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const form = element<HTMLFormElement>("settings-form");
const apiKey = element<HTMLInputElement>("api-key");
const baseUrl = element<HTMLInputElement>("base-url");
const model = element<HTMLInputElement>("model");
const imageModel = element<HTMLInputElement>("image-model");
const allowInsecureHttp = element<HTMLInputElement>("allow-insecure-http");
const insecureHttpRisk = element("insecure-http-risk");
const sourceLanguage = element<HTMLSelectElement>("source-language");
const targetLanguage = element<HTMLSelectElement>("target-language");
const dynamicContent = element<HTMLInputElement>("dynamic-content");
const selectionButton = element<HTMLInputElement>("selection-button");
const glossary = element<HTMLTextAreaElement>("glossary");
const toggleKey = element<HTMLButtonElement>("toggle-key");
const testButton = element<HTMLButtonElement>("test-button");
const permissionButton = element<HTMLButtonElement>("permission-button");
const saveButton = element<HTMLButtonElement>("save-button");
const connectionStatus = element("connection-status");
const formNotice = element("form-notice");
let previousBaseUrl = "";

function checkedValue(name: string): string {
  return form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? "";
}

function setRadio(name: string, value: string): void {
  const input = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function readForm(): Settings {
  return {
    provider: checkedValue("provider") as Provider,
    apiKey: apiKey.value.trim(),
    baseUrl: baseUrl.value.trim(),
    model: model.value.trim(),
    imageModel: imageModel.value.trim(),
    allowInsecureHttp: allowInsecureHttp.checked,
    sourceLanguage: sourceLanguage.value,
    targetLanguage: targetLanguage.value,
    translationStyle: checkedValue("translationStyle") as TranslationStyle,
    translateDynamicContent: dynamicContent.checked,
    showSelectionButton: selectionButton.checked,
    displayMode: normalizeDisplayMode(checkedValue("displayMode")) as DisplayMode,
    glossary: glossary.value
  };
}

function updateRiskVisibility(): void {
  insecureHttpRisk.hidden = !showsInsecureHttpRisk(baseUrl.value.trim());
}

function fillForm(settings: Settings): void {
  setRadio("provider", settings.provider);
  setRadio("translationStyle", settings.translationStyle);
  apiKey.value = settings.apiKey;
  baseUrl.value = settings.baseUrl;
  model.value = settings.model;
  imageModel.value = settings.imageModel;
  allowInsecureHttp.checked = settings.allowInsecureHttp;
  sourceLanguage.value = settings.sourceLanguage;
  targetLanguage.value = settings.targetLanguage;
  dynamicContent.checked = settings.translateDynamicContent;
  selectionButton.checked = settings.showSelectionButton;
  setRadio("displayMode", settings.displayMode);
  glossary.value = settings.glossary;
  permissionButton.hidden = settings.provider !== "custom";
  previousBaseUrl = baseUrl.value;
  updateRiskVisibility();
}

function notice(message: string, error = false): void {
  formNotice.textContent = message;
  formNotice.classList.toggle("error", error);
}

function setConnection(message: string, state?: "success" | "error"): void {
  connectionStatus.textContent = message;
  connectionStatus.className = `connection-status${state ? ` ${state}` : ""}`;
}

form.querySelectorAll<HTMLInputElement>('input[name="provider"]').forEach((input) => input.addEventListener("change", () => {
  const provider = input.value as Provider;
  const fields = applyProviderChange({
    baseUrl: baseUrl.value,
    model: model.value,
    allowInsecureHttp: allowInsecureHttp.checked
  }, provider);
  baseUrl.value = fields.baseUrl;
  model.value = fields.model;
  allowInsecureHttp.checked = fields.allowInsecureHttp;
  previousBaseUrl = baseUrl.value;
  permissionButton.hidden = provider !== "custom";
  updateRiskVisibility();
  setConnection("配置已更改");
}));

baseUrl.addEventListener("input", () => {
  allowInsecureHttp.checked = consentAfterBaseUrlChange(previousBaseUrl, baseUrl.value, allowInsecureHttp.checked);
  previousBaseUrl = baseUrl.value;
  updateRiskVisibility();
});

toggleKey.addEventListener("click", () => {
  const reveal = apiKey.type === "password";
  apiKey.type = reveal ? "text" : "password";
  toggleKey.textContent = reveal ? "隐藏" : "显示";
});

permissionButton.addEventListener("click", async () => {
  try {
    const permission = await requestTransportPermission(readForm(), chrome.permissions.request);
    notice(permission.granted ? `已授权 ${permission.origin}` : "未授予域名访问权限", !permission.granted);
  } catch (error) {
    notice(error instanceof Error ? error.message : "授权失败", true);
  }
});

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  testButton.textContent = "测试中…";
  setConnection("正在连接");
  try {
    const settings = readForm();
    const permission = await requestTransportPermission(settings, chrome.permissions.request);
    if (!permission.granted) throw new Error("需要先授权 API 域名");
    const response = await chrome.runtime.sendMessage({ type: "TEST_PROVIDER", settings }) as Response<{ message: string }>;
    if (!response.ok) throw new Error(response.error);
    setConnection("连接成功", "success");
    notice("测试译文已成功返回。保存后即可在任意网页使用。");
  } catch (error) {
    setConnection("连接失败", "error");
    notice(error instanceof Error ? error.message : "连接失败", true);
  } finally {
    testButton.disabled = false;
    testButton.textContent = "测试连接";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  try {
    const settings = readForm();
    const permission = await requestTransportPermission(settings, chrome.permissions.request);
    if (!permission.granted) throw new Error("需要授权 API 域名。");
    if (!settings.apiKey) throw new Error("请填写 API Key。");
    if (!settings.baseUrl || !settings.model) throw new Error("请填写 API 地址和模型名称。");
    await saveSettings(settings);
    notice("设置已安全保存在本机。");
  } catch (error) {
    notice(error instanceof Error ? error.message : "保存失败", true);
  } finally {
    saveButton.disabled = false;
  }
});

void loadSettings().then(fillForm).catch(() => fillForm(DEFAULT_SETTINGS));
