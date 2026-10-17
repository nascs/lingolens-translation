import type { TranslationItem, TranslationResult } from "../shared/messages";
import type { ParagraphStyle, StyledParagraph } from "./style";

export interface PdfTranslationItem extends TranslationItem {
  pageNumber: number;
  style?: ParagraphStyle;
  anchorY?: number;
  fontSizeRatio?: number;
  centered?: boolean;
}

export interface TranslationQueueOptions {
  generation: number;
  isCurrent: (generation: number) => boolean;
  send: (items: TranslationItem[]) => Promise<TranslationResult[]>;
  onResults: (items: readonly PdfTranslationItem[], results: ReadonlyMap<string, string>) => void;
  onFailure: (items: readonly PdfTranslationItem[], retry: () => void) => void;
  onIdle?: () => void;
  concurrency?: number;
}

export const MAX_BATCH_ITEMS = 4;
export const MAX_BATCH_CHARACTERS = 2500;

export function splitParagraph(text: string, maxCharacters = MAX_BATCH_CHARACTERS): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxCharacters) {
    const candidate = remaining.slice(0, maxCharacters + 1);
    const whitespace = candidate.search(/\s+\S*$/u);
    const splitAt = whitespace > Math.floor(maxCharacters * 0.5) ? whitespace : maxCharacters;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function translationItemsForPage(pageNumber: number, paragraphs: readonly StyledParagraph[]): PdfTranslationItem[] {
  const items: PdfTranslationItem[] = [];
  let chunkIndex = 0;
  for (const paragraph of paragraphs) {
    const chunks = splitParagraph(paragraph.text);
    for (let index = 0; index < chunks.length; index += 1) {
      chunkIndex += 1;
      const chunk = chunks[index] as string;
      const item: PdfTranslationItem = {
        id: `pdf-page-${pageNumber}-chunk-${chunkIndex}`,
        pageNumber,
        text: chunk,
        style: paragraph.style
      };
      if (index === 0) {
        if (paragraph.anchorY !== undefined) item.anchorY = paragraph.anchorY;
        if (paragraph.fontSizeRatio !== undefined) item.fontSizeRatio = paragraph.fontSizeRatio;
        if (paragraph.centered !== undefined) item.centered = paragraph.centered;
      }
      items.push(item);
    }
  }
  return items;
}

export function batchTranslationItems(items: readonly PdfTranslationItem[]): PdfTranslationItem[][] {
  const batches: PdfTranslationItem[][] = [];
  let batch: PdfTranslationItem[] = [];
  let characters = 0;
  for (const item of items) {
    if (batch.length >= MAX_BATCH_ITEMS || characters + item.text.length > MAX_BATCH_CHARACTERS) {
      if (batch.length) batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(item);
    characters += item.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export class TranslationQueue {
  private readonly pending: PdfTranslationItem[][] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private active = 0;
  private cancelled = false;
  private readonly concurrency: number;

  constructor(private readonly options: TranslationQueueOptions) {
    this.concurrency = Math.max(1, Math.min(2, options.concurrency ?? 2));
  }

  enqueue(items: readonly PdfTranslationItem[]): void {
    if (this.cancelled || !items.length) return;
    this.pending.push(...batchTranslationItems(items));
    this.pump();
  }

  cancel(): void {
    this.cancelled = true;
    this.pending.length = 0;
    this.settleIdle();
  }

  whenIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private pump(): void {
    while (!this.cancelled && this.active < this.concurrency) {
      const batch = this.pending.shift();
      if (!batch) break;
      this.active += 1;
      void this.run(batch);
    }
    this.settleIdle();
  }

  private async run(batch: PdfTranslationItem[]): Promise<void> {
    try {
      const response = await this.options.send(batch.map(({ id, text }) => ({ id, text })));
      if (!this.cancelled && this.options.isCurrent(this.options.generation)) {
        const expected = new Set(batch.map(({ id }) => id));
        const results = new Map(response.filter(({ id }) => expected.has(id)).map(({ id, text }) => [id, text]));
        this.options.onResults(batch, results);
      }
    } catch {
      if (!this.cancelled && this.options.isCurrent(this.options.generation)) {
        let retried = false;
        this.options.onFailure(batch, () => {
          if (retried || this.cancelled || !this.options.isCurrent(this.options.generation)) return;
          retried = true;
          this.pending.push(batch);
          this.pump();
        });
      }
    } finally {
      this.active -= 1;
      this.pump();
    }
  }

  private settleIdle(): void {
    if (this.active !== 0 || this.pending.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    if (!this.cancelled && this.options.isCurrent(this.options.generation)) this.options.onIdle?.();
  }
}
