import { describe, expect, it, vi } from "vitest";
import { PdfTranslationCancelledError, PdfTranslationManager } from "./pdf-translations";

describe("PdfTranslationManager", () => {
  it("aborts and settles two old requests before two new requests can start", async () => {
    const manager = new PdfTranslationManager();
    const oldSignals: AbortSignal[] = [];
    const oldReleases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const oldTask = (signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      active += 1;
      peak = Math.max(peak, active);
      oldSignals.push(signal);
      oldReleases.push(() => { active -= 1; reject(new PdfTranslationCancelledError()); });
    });

    const oldOne = manager.run(7, oldTask);
    const oldTwo = manager.run(7, oldTask);
    const thirdTask = vi.fn(async () => "must not start");
    const blockedThird = manager.run(7, thirdTask);
    void oldOne.catch(() => undefined);
    void oldTwo.catch(() => undefined);
    void blockedThird.catch(() => undefined);
    await Promise.resolve();
    expect(oldSignals).toHaveLength(2);
    expect(peak).toBe(2);

    let cancellationSettled = false;
    const cancellation = manager.cancelAndWait(7).then(() => { cancellationSettled = true; });
    await Promise.resolve();
    expect(oldSignals.every(({ aborted }) => aborted)).toBe(true);
    expect(cancellationSettled).toBe(false);
    for (const release of oldReleases) release();
    await cancellation;
    await expect(blockedThird).rejects.toBeInstanceOf(PdfTranslationCancelledError);
    expect(thirdTask).not.toHaveBeenCalled();

    const newTask = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return "new";
    };
    await Promise.all([manager.run(7, newTask), manager.run(7, newTask)]);
    expect(peak).toBe(2);
  });

  it("enforces the global limit across tabs", async () => {
    const manager = new PdfTranslationManager();
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const task = (id: number) => () => new Promise<number>((resolve) => {
      started.push(id);
      releases.push(() => resolve(id));
    });
    const first = manager.run(1, task(1));
    const second = manager.run(2, task(2));
    const third = manager.run(3, task(3));
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    releases.shift()?.();
    await first;
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    for (const release of releases) release();
    await Promise.all([second, third]);
  });
});
