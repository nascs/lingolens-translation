import { describe, expect, it, vi } from "vitest";
import { TranslationQueue, type PdfTranslationItem } from "./queue";
import {
  disposeAfterTranslationCancellation,
  clearPageCanvasPair,
  handleCanvasRenderFailure,
  handlePagePairRenderFailure,
  type CancellableTranslationQueue
} from "./lifecycle";

const items = (count: number): PdfTranslationItem[] => Array.from({ length: count }, (_, index) => ({
  id: `item-${index}`,
  pageNumber: 1,
  text: "text"
}));

describe("PDF lifecycle", () => {
  it("cancels local pending work before remote settle and delays destroy", async () => {
    const releases: Array<() => void> = [];
    const send = vi.fn((batch: Array<{ id: string; text: string }>) => new Promise<Array<{ id: string; text: string }>>((resolve) => {
      releases.push(() => resolve(batch));
    }));
    const queue = new TranslationQueue({ generation: 1, isCurrent: () => true, send, onResults: vi.fn(), onFailure: vi.fn() });
    queue.enqueue(items(12));
    expect(send).toHaveBeenCalledTimes(2);

    const events: string[] = [];
    const localQueue: CancellableTranslationQueue = {
      cancel: () => { events.push("local-cancel"); queue.cancel(); }
    };
    let queueReference: CancellableTranslationQueue | undefined = localQueue;
    let settleRemote: (() => void) | undefined;
    const remote = new Promise<void>((resolve) => { settleRemote = resolve; });
    const disposal = disposeAfterTranslationCancellation({
      queue: queueReference,
      clearQueueReference: () => { queueReference = undefined; },
      cancelRemote: async () => { await remote; events.push("remote-settle"); return true; },
      destroyDocument: async () => { events.push("destroy"); }
    });

    expect(queueReference).toBeUndefined();
    expect(events).toEqual(["local-cancel"]);
    settleRemote?.();
    await expect(disposal).resolves.toBe(true);
    expect(events).toEqual(["local-cancel", "remote-settle", "destroy"]);
    for (const release of releases) release();
    await queue.whenIdle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("clears an allocated canvas before reporting a real render failure", async () => {
    const canvas = { width: 1200, height: 800, removeAttribute: vi.fn() };
    const reported = vi.fn(() => {
      expect(canvas.width).toBe(0);
      expect(canvas.height).toBe(0);
    });
    try {
      await Promise.reject(new Error("render failed"));
    } catch {
      handleCanvasRenderFailure(canvas, reported);
    }
    expect(reported).toHaveBeenCalledOnce();
    expect(canvas.removeAttribute).toHaveBeenCalledWith("style");
  });

  it("clears both canvases in a rendered page pair", () => {
    const original = { width: 1000, height: 1400, removeAttribute: vi.fn() };
    const translation = { width: 1000, height: 1400, removeAttribute: vi.fn() };
    clearPageCanvasPair(original, translation);
    expect([original.width, original.height, translation.width, translation.height]).toEqual([0, 0, 0, 0]);
  });

  it("clears a page pair before reporting a render failure", () => {
    const original = { width: 900, height: 1200 };
    const translation = { width: 900, height: 1200 };
    const reported = vi.fn(() => {
      expect(original.width + translation.width).toBe(0);
      expect(original.height + translation.height).toBe(0);
    });
    handlePagePairRenderFailure(original, translation, reported);
    expect(reported).toHaveBeenCalledOnce();
  });
});
