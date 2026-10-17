import "./styles.css";
import type { DisplayMode, TranslationStyle } from "../shared/config";
import type { PageRequest, PageStatus, Response, TranslationItem, TranslationResult } from "../shared/messages";
import { collectTranslatableElements, normalizedElementText, resolveTranslationInsertAnchor } from "./dom";

declare global {
  interface Window { __lingoLensLoaded?: boolean; }
}

if (!window.__lingoLensLoaded) {
  window.__lingoLensLoaded = true;

  const SCROLL_DEBOUNCE = 200;
  const MUTATION_DEBOUNCE = 350;
  const CONCURRENCY = 4;
  const BATCH_SIZE = 8;
  const MAX_BATCH_CHARS = 4000;

  let status: PageStatus = { state: "idle", total: 0, completed: 0 };
  let style: TranslationStyle = "subtle";
  const translations = new Map<HTMLElement, HTMLElement>();
  let pending: HTMLElement[] = [];
  let discoveryOrder = new WeakMap<HTMLElement, number>();
  let discoveryCounter = 0;
  let observer: MutationObserver | undefined;
  let scanTimer: number | undefined;
  let scrollTimer: number | undefined;
  let scrollListener: ((event: Event) => void) | undefined;
  let generation = 0;
  let requestCounter = 0;
  let widget: HTMLDivElement | undefined;
  let displayMode: DisplayMode = "bilingual";
  const insertHosts = new Set<HTMLElement>();

  interface DrainTask {
    generation: number;
    settled: Promise<void>;
    resolveSettled: () => void;
    failureLocked: boolean;
    failureError?: unknown;
    cleanRound: boolean;
  }

  let currentTask: DrainTask | undefined;
  let drainRequested = false;
  let retryTimerHandle: number | undefined;
  let retryDeadline = 0;
  let retryToken = 0;
  let failedRounds = 0;
  let manualRetryIntent = false;
  let schedulerRunning = false;

  interface ContentSettings {
    sourceLanguage: string;
    targetLanguage: string;
    translateDynamicContent: boolean;
    showSelectionButton: boolean;
    translationStyle: TranslationStyle;
    displayMode: DisplayMode;
  }

  // 内容脚本必须保持零运行时 import（否则构建成 ESM，无法被 executeScript 注入）。
  function normalizeDisplayMode(value: unknown): DisplayMode {
    return value === "translation" || value === "hover" ? value : "bilingual";
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "发生了未知错误";
  }

  async function loadContentSettings(): Promise<ContentSettings> {
    const stored: unknown = await chrome.storage.local.get([
      "sourceLanguage",
      "targetLanguage",
      "translateDynamicContent",
      "showSelectionButton",
      "translationStyle",
      "displayMode"
    ]);
    const value = typeof stored === "object" && stored !== null ? stored as Record<string, unknown> : {};
    return {
      sourceLanguage: typeof value.sourceLanguage === "string" ? value.sourceLanguage : "auto",
      targetLanguage: typeof value.targetLanguage === "string" ? value.targetLanguage : "zh-CN",
      translateDynamicContent: typeof value.translateDynamicContent === "boolean" ? value.translateDynamicContent : true,
      showSelectionButton: typeof value.showSelectionButton === "boolean" ? value.showSelectionButton : true,
      translationStyle: value.translationStyle === "card" || value.translationStyle === "underline" ? value.translationStyle : "subtle",
      displayMode: normalizeDisplayMode(value.displayMode)
    };
  }

  function applyDisplayMode(mode: DisplayMode): void {
    displayMode = mode;
    document.documentElement.dataset.lingolensMode = mode;
    if (mode !== "hover") {
      document.querySelectorAll<HTMLElement>(".lingolens-hover-visible").forEach((node) => node.classList.remove("lingolens-hover-visible"));
    }
    renderWidget();
  }

  function hostForTranslation(node: HTMLElement): HTMLElement | undefined {
    let previous = node.previousElementSibling;
    while (previous instanceof HTMLElement && previous.classList.contains("lingolens-translation")) {
      previous = previous.previousElementSibling;
    }
    return previous instanceof HTMLElement && previous.classList.contains("lingolens-insert-host") ? previous : undefined;
  }

  function installHoverPreview(): void {
    document.addEventListener("mouseover", (event) => {
      if (displayMode !== "hover") return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const translation = target.closest<HTMLElement>(".lingolens-translation");
      if (translation) {
        translation.classList.add("lingolens-hover-visible");
        return;
      }
      const host = target.closest<HTMLElement>(".lingolens-insert-host");
      if (!host) return;
      let next = host.nextElementSibling;
      while (next instanceof HTMLElement && next.classList.contains("lingolens-translation")) {
        next.classList.add("lingolens-hover-visible");
        next = next.nextElementSibling;
      }
    }, true);
    document.addEventListener("mouseout", () => {
      if (displayMode !== "hover") return;
      window.setTimeout(() => {
        document.querySelectorAll<HTMLElement>(".lingolens-hover-visible").forEach((node) => {
          if (node.matches(":hover")) return;
          if (hostForTranslation(node)?.matches(":hover")) return;
          node.classList.remove("lingolens-hover-visible");
        });
      }, 160);
    }, true);
  }

  function buildExport(): { count: number; markdown: string; filename: string } {
    const parts: string[] = [];
    document.querySelectorAll<HTMLElement>(".lingolens-translation").forEach((node) => {
      const original = (node.dataset.lingolensOriginal ?? "").trim();
      const translation = normalizedElementText(node);
      if (!original || !translation) return;
      parts.push(`**原文**\n\n${original}\n\n**译文**\n\n${translation}`);
    });
    const host = location.hostname || "page";
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const header = `# ${document.title || host}\n\n> 来源：${location.href}\n> 导出时间：${new Date().toLocaleString()}\n> 译文条数：${parts.length}\n`;
    const markdown = parts.length ? `${header}\n${parts.join("\n\n---\n\n")}\n` : header;
    return { count: parts.length, markdown, filename: `lingolens-${host}-${stamp}.md` };
  }

  function report(): void {
    void chrome.runtime.sendMessage({ type: "PAGE_STATUS_CHANGED", status });
    renderWidget();
  }

  function setStatus(next: PageStatus): void {
    status = next;
    report();
  }

  function isPaused(): boolean {
    return status.state === "paused";
  }

  function discoveredCount(): number {
    return translations.size + pending.length;
  }

  function backoff(n: number): number {
    return Math.min(30_000, 1_000 * 3 ** (n - 1));
  }

  function clearRetryTimer(): void {
    if (retryTimerHandle !== undefined) {
      window.clearTimeout(retryTimerHandle);
      retryTimerHandle = undefined;
    }
    retryToken += 1;
  }

  function armRetryTimer(): void {
    if (isPaused() || retryDeadline === 0 || retryTimerHandle !== undefined) return;
    const gen = generation;
    const deadline = retryDeadline;
    const token = retryToken;
    const tick = (): void => {
      retryTimerHandle = undefined;
      if (gen !== generation || token !== retryToken || deadline !== retryDeadline) return;
      const remaining = retryDeadline - Date.now();
      if (remaining > 0) {
        retryTimerHandle = window.setTimeout(tick, remaining);
        return;
      }
      retryDeadline = 0;
      retryToken += 1;
      requestDrain();
    };
    const delay = retryDeadline - Date.now();
    if (delay <= 0) {
      retryDeadline = 0;
      retryToken += 1;
      requestDrain();
      return;
    }
    retryTimerHandle = window.setTimeout(tick, delay);
  }

  function ensureRetryTimer(): void {
    if (retryDeadline === 0) return;
    if (Date.now() >= retryDeadline) {
      clearRetryTimer();
      retryDeadline = 0;
      requestDrain();
      return;
    }
    if (retryTimerHandle === undefined) armRetryTimer();
  }

  function settleBatch(
    task: DrainTask,
    batch: HTMLElement[],
    items: TranslationItem[],
    ok: boolean,
    data: TranslationResult[] | undefined,
    error: unknown
  ): void {
    if (task.generation !== generation) return;
    if (isPaused()) {
      pending.push(...batch);
      task.cleanRound = false;
      return;
    }
    if (status.state === "idle") return;
    if (ok) {
      if (!data) return;
      const byId = new Map(data.map((item) => [item.id, item.text]));
      batch.forEach((element, index) => {
        const text = byId.get(items[index]?.id ?? "");
        if (text && !translations.has(element)) insertTranslation(element, text);
      });
    } else {
      pending.push(...batch);
      task.cleanRound = false;
      if (!task.failureLocked) {
        task.failureLocked = true;
        task.failureError = error;
      }
    }
  }

  async function runWorker(task: DrainTask, settings: ContentSettings): Promise<void> {
    while (task.generation === generation && !isPaused() && !task.failureLocked && pending.length > 0) {
      const batch = takeBatch();
      if (!batch.length) return;
      const items = batch.map((element, index) => ({
        id: `${task.generation}-${requestCounter++}-${index}`,
        text: normalizedElementText(element)
      }));
      try {
        const response = await chrome.runtime.sendMessage({
          type: "TRANSLATE_BATCH",
          items,
          sourceLanguage: settings.sourceLanguage,
          targetLanguage: settings.targetLanguage
        }) as Response<TranslationResult[]>;
        if (!response.ok) settleBatch(task, batch, items, false, undefined, new Error(response.error));
        else settleBatch(task, batch, items, true, response.data, undefined);
      } catch (error) {
        settleBatch(task, batch, items, false, undefined, error);
      }
    }
  }

  function commitTask(task: DrainTask): void {
    if (task.generation !== generation) return;
    if (task.failureLocked) {
      failedRounds += 1;
      retryDeadline = Date.now() + backoff(failedRounds);
    }
    // 服务已恢复且队列清空：用户“立即重试”意图已无对象，丢弃以免污染后续暂停/继续。
    if (task.cleanRound && pending.length === 0) manualRetryIntent = false;

    if (isPaused()) {
      if (task.failureLocked) {
        setStatus({ ...status, state: "paused", total: discoveredCount(), completed: translations.size, error: errorMessage(task.failureError) });
      }
      return;
    }

    if (task.failureLocked) {
      setStatus({ ...status, state: "error", total: discoveredCount(), completed: translations.size, error: errorMessage(task.failureError) });
      armRetryTimer();
      return;
    }
    if (!task.cleanRound) return;
    failedRounds = 0;
    retryDeadline = 0;
    clearRetryTimer();
    if (pending.length === 0) {
      setStatus({ state: "completed", total: translations.size, completed: translations.size });
    } else {
      setStatus({ state: "translating", total: discoveredCount(), completed: translations.size });
      requestDrain();
    }
  }

  function publishTask(run: number): void {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const task: DrainTask = {
      generation: run,
      settled,
      resolveSettled,
      failureLocked: false,
      cleanRound: true
    };
    currentTask = task;
    void (async () => {
      try {
        const settings = await loadContentSettings();
        const workerCount = Math.min(CONCURRENCY, Math.max(1, pending.length));
        await Promise.allSettled(Array.from({ length: workerCount }, () => runWorker(task, settings)));
        commitTask(task);
      } finally {
        if (currentTask === task) currentTask = undefined;
        task.resolveSettled();
      }
    })();
  }

  function requestDrain(): void {
    drainRequested = true;
    if (!schedulerRunning) {
      schedulerRunning = true;
      void schedulerLoop();
    }
  }

  async function schedulerLoop(): Promise<void> {
    for (;;) {
      const task = currentTask;
      if (task !== undefined) {
        await task.settled;
        continue;
      }
      const now = Date.now();
      const deadlineOpen = retryDeadline === 0 || now >= retryDeadline;
      if (!drainRequested || isPaused() || pending.length === 0 || (!deadlineOpen && !manualRetryIntent)) {
        schedulerRunning = false;
        return;
      }
      drainRequested = false;
      if (manualRetryIntent) {
        manualRetryIntent = false;
        retryDeadline = 0;
        failedRounds = 0;
        clearRetryTimer();
      }
      publishTask(generation);
    }
  }

  function resetDrainState(): void {
    clearRetryTimer();
    retryDeadline = 0;
    failedRounds = 0;
    manualRetryIntent = false;
    drainRequested = false;
    currentTask = undefined;
  }

  function scanAndTranslate(): void {
    const state = status.state;
    if (state !== "translating" && state !== "completed" && state !== "error") return;
    const found = collectTranslatableElements().filter((element) => !translations.has(element));
    for (const element of found) {
      if (!discoveryOrder.has(element)) {
        discoveryOrder.set(element, discoveryCounter++);
        pending.push(element);
      }
    }
    if (pending.length === 0) {
      if (state === "translating") setStatus({ state: "completed", total: translations.size, completed: translations.size });
      return;
    }
    if (state === "error") {
      setStatus({ ...status, total: discoveredCount(), completed: translations.size });
      ensureRetryTimer();
      if (retryDeadline === 0) requestDrain();
      return;
    }
    setStatus({ state: "translating", total: discoveredCount(), completed: translations.size });
    requestDrain();
  }

  function scheduleScan(): void {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => scanAndTranslate(), MUTATION_DEBOUNCE);
  }

  function isOwnedChange(record: MutationRecord): boolean {
    const added = Array.from(record.addedNodes);
    if (added.length > 0) {
      return added.every((node) => node instanceof Element && Boolean(node.closest(".lingolens-owned")));
    }
    const removed = Array.from(record.removedNodes);
    if (removed.length > 0) {
      return removed.every((node) => node instanceof Element && Boolean(node.closest(".lingolens-owned")));
    }
    const node = record.target;
    const element = node instanceof Element ? node : node.parentElement;
    return Boolean(element?.closest(".lingolens-owned"));
  }

  function watchDynamicContent(): void {
    if (!observer) {
      observer = new MutationObserver((records) => {
        if (records.some((record) => !isOwnedChange(record))) scheduleScan();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden"]
      });
    }
    if (!scrollListener) {
      scrollListener = () => {
        window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(() => scanAndTranslate(), SCROLL_DEBOUNCE);
      };
      window.addEventListener("scroll", scrollListener, { passive: true, capture: true });
    }
  }

  async function start(nextStyle: TranslationStyle): Promise<void> {
    style = nextStyle;
    if (status.state === "idle") {
      generation += 1;
      resetDrainState();
      setStatus({ state: "translating", total: 0, completed: 0 });
      const settings = await loadContentSettings();
      applyDisplayMode(settings.displayMode);
      if (settings.translateDynamicContent) watchDynamicContent();
      scanAndTranslate();
      return;
    }
    if (status.state === "error") {
      manualRetry();
      return;
    }
    if (status.state !== "paused") requestDrain();
  }

  function manualRetry(): void {
    if (currentTask !== undefined) {
      manualRetryIntent = true;
    } else {
      clearRetryTimer();
      retryDeadline = 0;
      failedRounds = 0;
    }
    requestDrain();
  }

  function pause(): void {
    if (status.state === "idle" || status.state === "paused") return;
    setStatus({ ...status, state: "paused" });
    clearRetryTimer();
  }

  function resume(): void {
    if (status.state !== "paused") return;
    if (retryDeadline === 0 && !manualRetryIntent) {
      setStatus({ ...status, state: "translating", error: undefined });
      scanAndTranslate();
      return;
    }
    setStatus({ ...status, state: "error" });
    if (manualRetryIntent || Date.now() >= retryDeadline) {
      clearRetryTimer();
      retryDeadline = 0;
      requestDrain();
    } else {
      armRetryTimer();
    }
  }

  function restore(): void {
    generation += 1;
    resetDrainState();
    observer?.disconnect();
    observer = undefined;
    window.clearTimeout(scanTimer);
    window.clearTimeout(scrollTimer);
    if (scrollListener) {
      window.removeEventListener("scroll", scrollListener, true);
      scrollListener = undefined;
    }
    for (const element of translations.keys()) element.classList.remove("lingolens-translated-source");
    for (const host of insertHosts) host.classList.remove("lingolens-insert-host");
    insertHosts.clear();
    for (const translated of translations.values()) translated.remove();
    translations.clear();
    pending = [];
    discoveryOrder = new WeakMap<HTMLElement, number>();
    document.querySelectorAll(".lingolens-selection").forEach((element) => element.remove());
    setStatus({ state: "idle", total: 0, completed: 0 });
  }

  function viewportScore(element: HTMLElement): number {
    const rect = element.getBoundingClientRect();
    const visible = rect.bottom >= 0 && rect.top <= window.innerHeight;
    const distance = visible ? Math.max(0, rect.top) : Math.abs(rect.top - window.innerHeight);
    return (visible ? 0 : 1_000_000) + distance;
  }

  function sortPending(): void {
    const scores = new Map<HTMLElement, number>();
    for (const element of pending) scores.set(element, viewportScore(element));
    pending.sort((left, right) => {
      const diff = (scores.get(left) ?? 0) - (scores.get(right) ?? 0);
      if (diff !== 0) return diff;
      return (discoveryOrder.get(left) ?? 0) - (discoveryOrder.get(right) ?? 0);
    });
  }

  function takeBatch(): HTMLElement[] {
    sortPending();
    const batch: HTMLElement[] = [];
    let characters = 0;
    while (pending.length > 0 && batch.length < BATCH_SIZE) {
      const next = pending[0];
      if (!next) break;
      const length = normalizedElementText(next).length;
      if (batch.length > 0 && characters + length > MAX_BATCH_CHARS) break;
      pending.shift();
      batch.push(next);
      characters += length;
    }
    return batch;
  }

  function insertTranslation(element: HTMLElement, text: string): void {
    const original = normalizedElementText(element);
    const anchor = resolveTranslationInsertAnchor(element);
    const translated = document.createElement("div");
    translated.className = `lingolens-owned lingolens-translation lingolens-style-${style}`;
    translated.lang = "zh";
    translated.textContent = text;
    translated.dataset.lingolensOriginal = original;
    element.classList.add("lingolens-translated-source");
    anchor.classList.add("lingolens-insert-host");
    insertHosts.add(anchor);
    anchor.insertAdjacentElement("afterend", translated);
    translations.set(element, translated);
  }

  function createWidget(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.className = "lingolens-owned lingolens-panel";
    panel.innerHTML = `<div class="lingolens-panel-head"><span class="lingolens-panel-mark">译</span><span class="lingolens-panel-title"><strong>LingoLens</strong><small>BILINGUAL READER</small></span><button class="lingolens-panel-collapse" type="button" aria-label="折叠悬浮窗">‹</button></div><div class="lingolens-panel-body"><p class="lingolens-panel-status">准备翻译当前网页</p><button class="lingolens-panel-primary" type="button"><span>翻译此页</span><span>→</span></button><p class="lingolens-panel-hint">滚动页面自动翻译，无需手动操作</p><div class="lingolens-panel-actions"><button data-action="pause" type="button">暂停</button><button data-action="restore" type="button">还原</button></div><div class="lingolens-panel-modes" role="group" aria-label="显示模式"><button data-mode="bilingual" type="button">双语</button><button data-mode="translation" type="button">仅译文</button><button data-mode="hover" type="button">悬停</button></div><div class="lingolens-panel-links"><button data-action="translator" type="button">独立翻译页 ↗</button><button data-action="settings" type="button">设置</button></div></div>`;
    panel.querySelector(".lingolens-panel-collapse")?.addEventListener("click", () => panel.classList.toggle("is-collapsed"));
    panel.querySelector(".lingolens-panel-primary")?.addEventListener("click", () => {
      if (status.state === "error") { manualRetry(); return; }
      void loadContentSettings().then((settings) => start(settings.translationStyle));
    });
    panel.querySelector('[data-action="pause"]')?.addEventListener("click", () => {
      if (status.state === "paused") resume();
      else if (status.state !== "idle") pause();
    });
    panel.querySelector('[data-action="restore"]')?.addEventListener("click", restore);
    panel.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => button.addEventListener("click", () => {
      const mode = normalizeDisplayMode(button.dataset.mode);
      applyDisplayMode(mode);
      void chrome.storage.local.set({ displayMode: mode });
    }));
    panel.querySelector('[data-action="translator"]')?.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "OPEN_TRANSLATOR" }));
    panel.querySelector('[data-action="settings"]')?.addEventListener("click", () => void chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" }));
    document.documentElement.append(panel);
    return panel;
  }

  function renderWidget(): void {
    if (!widget) return;
    const labels: Record<PageStatus["state"], string> = {
      idle: "准备翻译当前网页",
      translating: "正在翻译，滚动后会自动跟随",
      paused: "已暂停自动翻译",
      completed: "当前内容已翻译，继续滚动会自动跟随",
      error: "网络或服务暂时不可用，正在自动重试…"
    };
    const statusNode = widget.querySelector<HTMLElement>(".lingolens-panel-status");
    const primaryButton = widget.querySelector<HTMLElement>(".lingolens-panel-primary");
    const primaryLabel = widget.querySelector<HTMLElement>(".lingolens-panel-primary span");
    const hint = widget.querySelector<HTMLElement>(".lingolens-panel-hint");
    const pause = widget.querySelector<HTMLButtonElement>('[data-action="pause"]');
    const restoreButton = widget.querySelector<HTMLButtonElement>('[data-action="restore"]');
    if (statusNode) statusNode.textContent = labels[status.state];
    if (primaryButton) primaryButton.style.display = status.state === "idle" || status.state === "error" ? "flex" : "none";
    if (primaryLabel) primaryLabel.textContent = status.state === "error" ? "立即重试" : "翻译此页";
    if (hint) hint.style.display = status.state === "idle" ? "none" : "block";
    if (pause) { pause.disabled = status.state === "idle"; pause.textContent = status.state === "paused" ? "继续" : "暂停"; }
    if (restoreButton) restoreButton.disabled = status.state === "idle";
    widget.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((button) => {
      const active = button.dataset.mode === displayMode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function showSelectionBubble(text: string, x: number, y: number): HTMLDivElement {
    document.querySelectorAll(".lingolens-selection").forEach((element) => element.remove());
    const bubble = document.createElement("div");
    bubble.className = "lingolens-owned lingolens-selection";
    bubble.textContent = "翻译选中文本";
    bubble.style.left = `${Math.min(x, window.innerWidth - 180)}px`;
    bubble.style.top = `${Math.min(y + 10, window.innerHeight - 70)}px`;
    bubble.addEventListener("click", () => void translateSelection(text, bubble), { once: true });
    document.body.append(bubble);
    return bubble;
  }

  async function translateSelection(text: string, bubble?: HTMLDivElement): Promise<void> {
    const target = bubble ?? showSelectionBubble(text, 18, 18);
    target.textContent = "AI 正在翻译…";
    try {
      const settings = await loadContentSettings();
      const response = await chrome.runtime.sendMessage({
        type: "TRANSLATE_BATCH",
        items: [{ id: "selection", text }],
        sourceLanguage: settings.sourceLanguage,
        targetLanguage: settings.targetLanguage
      }) as Response<TranslationResult[]>;
      if (!response.ok) throw new Error(response.error);
      target.dataset.mode = "result";
      target.textContent = response.data[0]?.text ?? "没有收到译文";
    } catch (error) {
      target.dataset.mode = "error";
      target.textContent = errorMessage(error);
    }
  }

  document.addEventListener("mouseup", async (event) => {
    const settings = await loadContentSettings();
    if (!settings.showSelectionButton) return;
    const text = window.getSelection()?.toString().trim() ?? "";
    if (text.length < 2 || text.length > 2000) return;
    showSelectionBubble(text, event.clientX, event.clientY);
  });

  chrome.runtime.onMessage.addListener((message: PageRequest, _sender, sendResponse) => {
    if (message.type === "PAGE_GET_STATUS") {
      sendResponse(status);
      return false;
    }
    if (message.type === "PAGE_RESTORE") {
      restore();
      sendResponse(status);
      return false;
    }
    if (message.type === "PAGE_TOGGLE_PAUSE") {
      if (status.state === "paused") resume();
      else if (status.state === "translating" || status.state === "completed" || status.state === "error") pause();
      sendResponse(status);
      return false;
    }
    if (message.type === "PAGE_START") {
      void start(message.style);
      sendResponse(status);
      return false;
    }
    if (message.type === "PAGE_TRANSLATE_SELECTION") {
      void translateSelection(message.text).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message.type === "PAGE_EXPORT_TRANSLATIONS") {
      sendResponse({ ok: true, data: buildExport() });
      return false;
    }
    return false;
  });

  installHoverPreview();
  void chrome.storage.local.get(["displayMode"]).then((stored) => {
    const value = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>).displayMode : undefined;
    applyDisplayMode(normalizeDisplayMode(value));
  }).catch(() => applyDisplayMode(displayMode));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.displayMode) return;
    applyDisplayMode(normalizeDisplayMode(changes.displayMode.newValue));
  });
  widget = createWidget();
  renderWidget();
}
