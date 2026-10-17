export class PdfTranslationCancelledError extends Error {
  readonly code = "CANCELLED";

  constructor() {
    super("PDF 翻译已取消。");
    this.name = "PdfTranslationCancelledError";
  }
}

interface PendingJob<T> {
  tabId: number;
  task: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

interface ActiveJob {
  controller: AbortController;
  settled: Promise<void>;
}

export class PdfTranslationManager {
  private readonly pending: Array<PendingJob<unknown>> = [];
  private readonly activeByTab = new Map<number, Set<ActiveJob>>();
  private readonly blockedTabs = new Set<number>();
  private readonly cancellations = new Map<number, Promise<void>>();
  private readonly maximumActive: number;
  private active = 0;

  constructor(maximumActive = 2) {
    this.maximumActive = Math.max(1, Math.min(2, maximumActive));
  }

  run<T>(tabId: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ tabId, task, resolve, reject } as PendingJob<unknown>);
      this.pump();
    });
  }

  cancelAndWait(tabId: number): Promise<void> {
    const existing = this.cancellations.get(tabId);
    if (existing) return existing;
    const cancellation = this.cancel(tabId).finally(() => this.cancellations.delete(tabId));
    this.cancellations.set(tabId, cancellation);
    return cancellation;
  }

  clearTab(tabId: number): Promise<void> {
    return this.cancelAndWait(tabId);
  }

  private async cancel(tabId: number): Promise<void> {
    this.blockedTabs.add(tabId);
    this.rejectPending(tabId);
    const active = [...(this.activeByTab.get(tabId) ?? [])];
    for (const job of active) job.controller.abort();
    await Promise.allSettled(active.map(({ settled }) => settled));
    this.rejectPending(tabId);
    this.blockedTabs.delete(tabId);
    this.pump();
  }

  private rejectPending(tabId: number): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const job = this.pending[index];
      if (job?.tabId !== tabId) continue;
      this.pending.splice(index, 1);
      job.reject(new PdfTranslationCancelledError());
    }
  }

  private pump(): void {
    while (this.active < this.maximumActive) {
      const index = this.pending.findIndex(({ tabId }) => !this.blockedTabs.has(tabId));
      if (index < 0) return;
      const job = this.pending.splice(index, 1)[0];
      if (!job) return;
      this.start(job);
    }
  }

  private start(job: PendingJob<unknown>): void {
    const controller = new AbortController();
    let settle: (() => void) | undefined;
    const activeJob: ActiveJob = {
      controller,
      settled: new Promise<void>((resolve) => { settle = resolve; })
    };
    const tabJobs = this.activeByTab.get(job.tabId) ?? new Set<ActiveJob>();
    tabJobs.add(activeJob);
    this.activeByTab.set(job.tabId, tabJobs);
    this.active += 1;

    void Promise.resolve()
      .then(() => job.task(controller.signal))
      .then(
        (value) => controller.signal.aborted ? job.reject(new PdfTranslationCancelledError()) : job.resolve(value),
        (error: unknown) => job.reject(controller.signal.aborted ? new PdfTranslationCancelledError() : error)
      )
      .finally(() => {
        tabJobs.delete(activeJob);
        if (!tabJobs.size) this.activeByTab.delete(job.tabId);
        this.active -= 1;
        settle?.();
        this.pump();
      });
  }
}
