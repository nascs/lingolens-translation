import { describe, expect, it, vi } from "vitest";
import {
  MAX_BATCH_CHARACTERS,
  TranslationQueue,
  batchTranslationItems,
  splitParagraph,
  translationItemsForPage,
  type PdfTranslationItem
} from "./queue";
import type { ParagraphStyle } from "./style";

const style: ParagraphStyle = { headingLevel: 0, serif: "serif", fontWeight: 400 };

describe("PDF translation chunking", () => {
  it("splits long paragraphs and creates stable page/chunk ids", () => {
    const items = translationItemsForPage(7, [
      { text: "a".repeat(MAX_BATCH_CHARACTERS + 10), style },
      { text: "second", style }
    ]);
    expect(items.map(({ id }) => id)).toEqual([
      "pdf-page-7-chunk-1",
      "pdf-page-7-chunk-2",
      "pdf-page-7-chunk-3"
    ]);
    expect(items.every(({ text }) => text.length <= MAX_BATCH_CHARACTERS)).toBe(true);
    expect(translationItemsForPage(1, [])).toEqual([]);
  });

  it("inherits the parent paragraph style across chunks and keeps ids stable", () => {
    const headingStyle: ParagraphStyle = { headingLevel: 1, serif: "sans", fontWeight: 700 };
    const items = translationItemsForPage(3, [
      { text: "Title", style: headingStyle },
      { text: "body", style }
    ]);
    expect(items.map(({ id }) => id)).toEqual(["pdf-page-3-chunk-1", "pdf-page-3-chunk-2"]);
    expect(items[0]?.style).toEqual(headingStyle);
    expect(items[1]?.style).toEqual(style);
  });

  it("prefers a nearby word boundary", () => {
    expect(splitParagraph(`${"a".repeat(8)} two`, 10)).toEqual(["aaaaaaaa", "two"]);
  });

  it("limits each batch to four items and 2500 characters", () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ id: String(index), pageNumber: 1, text: "x".repeat(600), style }));
    const batches = batchTranslationItems(items);
    expect(batches.map(({ length }) => length)).toEqual([4, 2]);
    expect(batches.every((batch) => batch.reduce((sum, item) => sum + item.text.length, 0) <= 2500)).toBe(true);
  });

  it("carries anchor geometry only on the first chunk of each paragraph", () => {
    const items = translationItemsForPage(2, [
      { text: "x".repeat(MAX_BATCH_CHARACTERS + 5), style, anchorY: 0.1, fontSizeRatio: 0.02 },
      { text: "short", style, anchorY: 0.5, fontSizeRatio: 0.015 }
    ]);
    expect(items.map(({ id }) => id)).toEqual([
      "pdf-page-2-chunk-1",
      "pdf-page-2-chunk-2",
      "pdf-page-2-chunk-3"
    ]);
    expect(items[0]?.anchorY).toBe(0.1);
    expect(items[0]?.fontSizeRatio).toBe(0.02);
    expect(items[1]?.anchorY).toBeUndefined();
    expect(items[1]?.fontSizeRatio).toBeUndefined();
    expect(items[2]?.anchorY).toBe(0.5);
    expect(items[2]?.fontSizeRatio).toBe(0.015);
  });

  it("carries centered only on the first chunk of each paragraph, including false", () => {
    const items = translationItemsForPage(4, [
      { text: "x".repeat(MAX_BATCH_CHARACTERS + 5), style, anchorY: 0.1, fontSizeRatio: 0.02, centered: true },
      { text: "short", style, anchorY: 0.5, fontSizeRatio: 0.015, centered: false }
    ]);
    expect(items[0]?.centered).toBe(true);
    expect(items[1]?.centered).toBeUndefined();
    expect(items[2]?.centered).toBe(false);
  });
});

describe("TranslationQueue", () => {
  const items = (count: number): PdfTranslationItem[] => Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    pageNumber: index + 1,
    text: "text",
    style
  }));

  it("never exceeds two concurrent requests", async () => {
    let active = 0;
    let peak = 0;
    const send = vi.fn(async (batch: Array<{ id: string; text: string }>) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return batch;
    });
    const queue = new TranslationQueue({ generation: 1, isCurrent: () => true, send, onResults: vi.fn(), onFailure: vi.fn() });
    queue.enqueue(items(12));
    await queue.whenIdle();
    expect(peak).toBe(2);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("maps out-of-order results by id", async () => {
    const onResults = vi.fn();
    const queue = new TranslationQueue({
      generation: 1,
      isCurrent: () => true,
      send: async (batch) => batch.toReversed().map(({ id }) => ({ id, text: `translated-${id}` })),
      onResults,
      onFailure: vi.fn()
    });
    queue.enqueue(items(2));
    await queue.whenIdle();
    const results = onResults.mock.calls[0]?.[1] as ReadonlyMap<string, string>;
    expect(results.get("item-0")).toBe("translated-item-0");
    expect(results.get("item-1")).toBe("translated-item-1");
  });

  it("isolates a failed batch and supports one retry", async () => {
    let attempts = 0;
    let retry: (() => void) | undefined;
    const onResults = vi.fn();
    const queue = new TranslationQueue({
      generation: 1,
      isCurrent: () => true,
      send: async (batch) => {
        attempts += 1;
        if (attempts === 1) throw new Error("failed");
        return batch.map(({ id }) => ({ id, text: "ok" }));
      },
      onResults,
      onFailure: (_batch, retryBatch) => { retry = retryBatch; }
    });
    queue.enqueue(items(1));
    await queue.whenIdle();
    expect(onResults).not.toHaveBeenCalled();
    retry?.();
    await queue.whenIdle();
    expect(onResults).toHaveBeenCalledOnce();
    expect(attempts).toBe(2);
  });

  it("keeps successful batches when a sibling batch fails", async () => {
    const onResults = vi.fn();
    const onFailure = vi.fn();
    const queue = new TranslationQueue({
      generation: 1,
      isCurrent: () => true,
      send: async (batch) => {
        if (batch.some(({ id }) => id === "item-0")) throw new Error("failed batch");
        return batch.map(({ id }) => ({ id, text: "ok" }));
      },
      onResults,
      onFailure
    });
    queue.enqueue(items(5));
    await queue.whenIdle();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onResults).toHaveBeenCalledOnce();
    expect((onResults.mock.calls[0]?.[0] as PdfTranslationItem[]).map(({ id }) => id)).toEqual(["item-4"]);
  });

  it("sends only id and text, never style, pageNumber, or anchor geometry", async () => {
    const sent: Array<Array<{ id: string; text: string }>> = [];
    const send = vi.fn(async (batch: Array<{ id: string; text: string }>) => {
      sent.push(batch);
      return batch;
    });
    const queue = new TranslationQueue({ generation: 1, isCurrent: () => true, send, onResults: vi.fn(), onFailure: vi.fn() });
    queue.enqueue([
      { id: "item-0", pageNumber: 1, text: "text", style, anchorY: 0.1, fontSizeRatio: 0.02 },
      { id: "anchored-0", pageNumber: 2, text: "text", style, anchorY: 0.2, fontSizeRatio: 0.03, centered: true }
    ]);
    await queue.whenIdle();
    expect(sent[0]?.[0]).toEqual({ id: "item-0", text: "text" });
    expect(sent[0]?.[1]).toEqual({ id: "anchored-0", text: "text" });
  });

  it("discards results from an old generation", async () => {
    let current = true;
    let release: (() => void) | undefined;
    const onResults = vi.fn();
    const queue = new TranslationQueue({
      generation: 1,
      isCurrent: () => current,
      send: async (batch) => { await new Promise<void>((resolve) => { release = resolve; }); return batch; },
      onResults,
      onFailure: vi.fn()
    });
    queue.enqueue(items(1));
    current = false;
    release?.();
    await queue.whenIdle();
    expect(onResults).not.toHaveBeenCalled();
  });

  it("drops locally pending batches on cancel", async () => {
    const releases: Array<() => void> = [];
    const send = vi.fn((batch: Array<{ id: string; text: string }>) => new Promise<Array<{ id: string; text: string }>>((resolve) => {
      releases.push(() => resolve(batch));
    }));
    const queue = new TranslationQueue({ generation: 1, isCurrent: () => true, send, onResults: vi.fn(), onFailure: vi.fn() });
    queue.enqueue(items(12));
    expect(send).toHaveBeenCalledTimes(2);
    queue.cancel();
    for (const release of releases) release();
    await queue.whenIdle();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
