export interface CancellableTranslationQueue {
  cancel(): void;
}

export interface CanvasBackingStore {
  width: number;
  height: number;
  removeAttribute?(name: string): void;
}

export function cancelAndClearTranslationQueue(
  queue: CancellableTranslationQueue | undefined,
  clearReference: () => void
): void {
  queue?.cancel();
  clearReference();
}

export async function disposeAfterTranslationCancellation<T>(options: {
  queue: CancellableTranslationQueue | undefined;
  clearQueueReference: () => void;
  cancelRemote: () => Promise<T>;
  destroyDocument: () => Promise<void>;
}): Promise<T> {
  cancelAndClearTranslationQueue(options.queue, options.clearQueueReference);
  try {
    return await options.cancelRemote();
  } finally {
    await options.destroyDocument();
  }
}

export function clearCanvasBackingStore(canvas: CanvasBackingStore): void {
  canvas.width = 0;
  canvas.height = 0;
  canvas.removeAttribute?.("style");
}

export function clearPageCanvasPair(originalCanvas: CanvasBackingStore, translationCanvas: CanvasBackingStore): void {
  clearCanvasBackingStore(originalCanvas);
  clearCanvasBackingStore(translationCanvas);
}

export function handleCanvasRenderFailure(canvas: CanvasBackingStore, onCurrentFailure?: () => void): void {
  clearCanvasBackingStore(canvas);
  onCurrentFailure?.();
}

export function handlePagePairRenderFailure(
  originalCanvas: CanvasBackingStore,
  translationCanvas: CanvasBackingStore,
  onCurrentFailure?: () => void
): void {
  clearPageCanvasPair(originalCanvas, translationCanvas);
  onCurrentFailure?.();
}
