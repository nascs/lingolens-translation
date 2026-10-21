import "./styles.css";
import { loadSettings } from "../shared/config";
import { fitWithin, isSupportedImageType, MAX_IMAGE_DATA_URL_LENGTH, MAX_IMAGE_EDGE } from "../shared/image";
import { resolveTargetLanguage, type TargetLanguageDecision } from "../shared/language";
import type { ImageTranslationResult, Response, TranslationResult } from "../shared/messages";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const tabText = element<HTMLButtonElement>("tab-text");
const tabImage = element<HTMLButtonElement>("tab-image");
const panelText = element("panel-text");
const panelImage = element("panel-image");

const textSource = element<HTMLSelectElement>("text-source");
const textTarget = element<HTMLSelectElement>("text-target");
const textInput = element<HTMLTextAreaElement>("text-input");
const textTranslate = element<HTMLButtonElement>("text-translate");
const textCopy = element<HTMLButtonElement>("text-copy");
const textNote = element("text-note");
const textResult = element("text-result");

const dropZone = element("drop-zone");
const imageFile = element<HTMLInputElement>("image-file");
const imageChoose = element<HTMLButtonElement>("image-choose");
const imagePreviewWrap = element("image-preview-wrap");
const imagePreview = element<HTMLImageElement>("image-preview");
const imageClear = element<HTMLButtonElement>("image-clear");
const imageTarget = element<HTMLSelectElement>("image-target");
const imageTranslate = element<HTMLButtonElement>("image-translate");
const imageNote = element("image-note");
const imageSettings = element<HTMLButtonElement>("image-settings");
const imageSourceWrap = element("image-source-wrap");
const imageSource = element("image-source");
const imageResultWrap = element("image-result-wrap");
const imageResult = element("image-result");
const imageCopy = element<HTMLButtonElement>("image-copy");

let imageDataUrl = "";
let translatedText = "";
let imageTranslatedText = "";
let targetTouched = false;
let imageTargetTouched = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "翻译失败";
}

function setNote(node: HTMLElement, message: string, isError = false): void {
  node.textContent = message;
  node.classList.toggle("is-error", isError);
}

function showPanel(view: "text" | "image"): void {
  const isImage = view === "image";
  tabText.classList.toggle("is-active", !isImage);
  tabImage.classList.toggle("is-active", isImage);
  tabText.setAttribute("aria-selected", String(!isImage));
  tabImage.setAttribute("aria-selected", String(isImage));
  panelText.hidden = isImage;
  panelImage.hidden = !isImage;
  history.replaceState(null, "", isImage ? "#image" : "#text");
  if (!isImage) textInput.focus();
}

function hasOption(select: HTMLSelectElement, value: string): boolean {
  return Array.from(select.options).some((option) => option.value === value);
}

function concreteSource(decision: TargetLanguageDecision): string {
  if (textSource.value !== "auto") return textSource.value;
  const detected = decision.detectedLanguage?.toLowerCase().replace("_", "-") ?? "";
  const primary = detected.split("-", 1)[0] ?? "";
  if (detected === "zh-tw" || detected === "zh-hant") return "zh-TW";
  if (primary === "zh" || decision.category === "chinese") return "zh-CN";
  if (["en", "ja", "ko", "fr", "de", "es"].includes(primary)) return primary;
  return decision.resolvedTargetLanguage === "zh-CN" ? "en" : "zh-CN";
}

async function translateText(): Promise<void> {
  const text = textInput.value.trim();
  if (!text) {
    setNote(textNote, "先输入要翻译的文本。", true);
    textInput.focus();
    return;
  }
  textTranslate.disabled = true;
  translatedText = "";
  textCopy.disabled = true;
  textResult.hidden = true;
  setNote(textNote, "正在翻译…");
  try {
    const decision = await resolveTargetLanguage(text, textTarget.value);
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_BATCH",
      items: [{ id: "quick", text }],
      sourceLanguage: concreteSource(decision),
      targetLanguage: decision.resolvedTargetLanguage
    }) as Response<TranslationResult[]>;
    if (!response.ok) throw new Error(response.error);
    translatedText = response.data[0]?.text ?? "";
    if (!translatedText) throw new Error("没有收到译文。");
    textResult.textContent = translatedText;
    textResult.hidden = false;
    textCopy.disabled = false;
    setNote(textNote, textTarget.value === "smart" ? decision.label : "");
  } catch (error) {
    setNote(textNote, errorMessage(error), true);
  } finally {
    textTranslate.disabled = false;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("无法读取这张图片。"));
    };
    reader.onerror = () => reject(new Error("无法读取这张图片。"));
    reader.readAsDataURL(file);
  });
}

/** 小图保持原始编码；大图按长边缩放并转成 JPEG，避免超出模型请求体限制。 */
async function prepareImage(file: File): Promise<string> {
  if (!isSupportedImageType(file.type)) throw new Error("只支持 PNG、JPEG 或 WebP 图片。");
  if (file.size > 25 * 1024 * 1024) throw new Error("图片超过 25 MB，请先裁剪。");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("无法解析这张图片，请换一张截图。");
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (longest <= MAX_IMAGE_EDGE && file.size <= 3 * 1024 * 1024) {
      const original = await readFileAsDataUrl(file);
      if (original.length <= MAX_IMAGE_DATA_URL_LENGTH) return original;
    }
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理这张图片。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const encoded = canvas.toDataURL("image/jpeg", 0.92);
    if (encoded.length > MAX_IMAGE_DATA_URL_LENGTH) throw new Error("图片太大，请先裁剪再试。");
    return encoded;
  } finally {
    bitmap.close();
  }
}

function clearImage(): void {
  imageDataUrl = "";
  imagePreview.removeAttribute("src");
  imagePreviewWrap.hidden = true;
  dropZone.hidden = false;
  imageTranslate.disabled = true;
  imageSettings.hidden = true;
  imageSourceWrap.hidden = true;
  imageResultWrap.hidden = true;
  imageTranslatedText = "";
  imageCopy.disabled = true;
  setNote(imageNote, "");
}

async function setImage(file: File): Promise<void> {
  setNote(imageNote, "正在处理图片…");
  try {
    const dataUrl = await prepareImage(file);
    imageDataUrl = dataUrl;
    imagePreview.src = dataUrl;
    imagePreviewWrap.hidden = false;
    dropZone.hidden = true;
    imageTranslate.disabled = false;
    imageSourceWrap.hidden = true;
    imageResultWrap.hidden = true;
    imageSettings.hidden = true;
    setNote(imageNote, "");
  } catch (error) {
    clearImage();
    setNote(imageNote, errorMessage(error), true);
  }
}

async function translateImage(): Promise<void> {
  if (!imageDataUrl) return;
  imageTranslate.disabled = true;
  imageSettings.hidden = true;
  imageTranslatedText = "";
  imageCopy.disabled = true;
  imageResultWrap.hidden = true;
  imageSourceWrap.hidden = true;
  setNote(imageNote, "正在识别并翻译图片…");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "TRANSLATE_IMAGE",
      imageDataUrl,
      sourceLanguage: "auto",
      targetLanguage: imageTarget.value
    }) as Response<ImageTranslationResult>;
    if (!response.ok) {
      if (response.code === "VISION_UNSUPPORTED") imageSettings.hidden = false;
      throw new Error(response.error);
    }
    imageTranslatedText = response.data.translatedText;
    imageResult.textContent = imageTranslatedText;
    imageResultWrap.hidden = false;
    imageCopy.disabled = !imageTranslatedText;
    if (response.data.sourceText) {
      imageSource.textContent = response.data.sourceText;
      imageSourceWrap.hidden = false;
    }
    setNote(imageNote, "");
  } catch (error) {
    setNote(imageNote, errorMessage(error), true);
  } finally {
    imageTranslate.disabled = !imageDataUrl;
  }
}

tabText.addEventListener("click", () => showPanel("text"));
tabImage.addEventListener("click", () => showPanel("image"));
textTranslate.addEventListener("click", () => void translateText());
textInput.addEventListener("keydown", (event) => {
  if (event.ctrlKey && (event.key === "Enter" || event.key === "NumpadEnter")) {
    event.preventDefault();
    void translateText();
  }
});
textCopy.addEventListener("click", async () => {
  if (!translatedText) return;
  try {
    await navigator.clipboard.writeText(translatedText);
    textCopy.textContent = "已复制";
    setNote(textNote, "");
  } catch {
    setNote(textNote, "复制失败，请手动选择译文。", true);
  }
  window.setTimeout(() => { textCopy.textContent = "复制"; }, 1200);
});

imageChoose.addEventListener("click", () => imageFile.click());
dropZone.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest("button")) return;
  imageFile.click();
});
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    imageFile.click();
  }
});
imageFile.addEventListener("change", () => {
  const file = imageFile.files?.[0];
  if (file) void setImage(file);
  imageFile.value = "";
});
imageClear.addEventListener("click", clearImage);
imageTranslate.addEventListener("click", () => void translateImage());
imageCopy.addEventListener("click", async () => {
  if (!imageTranslatedText) return;
  try {
    await navigator.clipboard.writeText(imageTranslatedText);
    imageCopy.textContent = "已复制";
    setNote(imageNote, "");
  } catch {
    setNote(imageNote, "复制失败，请手动选择译文。", true);
  }
  window.setTimeout(() => { imageCopy.textContent = "复制译文"; }, 1200);
});

document.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    event.preventDefault();
    showPanel("image");
    void setImage(file);
    return;
  }
});

window.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
window.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith("image/")) return;
  event.preventDefault();
  showPanel("image");
  void setImage(file);
});

element<HTMLButtonElement>("settings-button").addEventListener("click", () => void chrome.runtime.openOptionsPage());
imageSettings.addEventListener("click", () => void chrome.runtime.openOptionsPage());

textTarget.addEventListener("change", () => { targetTouched = true; });
imageTarget.addEventListener("change", () => { imageTargetTouched = true; });

void loadSettings()
  .then((settings) => {
    if (hasOption(textSource, settings.sourceLanguage)) textSource.value = settings.sourceLanguage;
    // 设置读取是异步的，不能覆盖用户已经做出的选择。
    if (!targetTouched && hasOption(textTarget, settings.targetLanguage)) textTarget.value = settings.targetLanguage;
    if (!imageTargetTouched && hasOption(imageTarget, settings.targetLanguage)) imageTarget.value = settings.targetLanguage;
  })
  .catch(() => {});

if (location.hash === "#image") showPanel("image");
else textInput.focus();
