import { weightedMedian } from "./font-classify";
import type { HeadingLevel } from "./style";

export const HEADING_LEVEL_RATIOS = { 1: 1.6, 2: 1.3, 3: 1.15 } as const;

export interface HeadingInput {
  fontSize: number;
  charCount: number;
  lineCount: number;
  text: string;
}

export interface HeadingDetectionOptions {
  baseline?: number;
}

export function baselineFontSize(inputs: readonly HeadingInput[]): number {
  return weightedMedian(inputs.map((input) => ({ value: input.fontSize, weight: input.charCount })));
}

export function detectHeadingLevels(
  inputs: readonly HeadingInput[],
  options?: HeadingDetectionOptions
): HeadingLevel[] {
  if (inputs.length < 3) return inputs.map(() => 0);
  const sizes = inputs.map((input) => input.fontSize);
  const maxSize = Math.max(...sizes);
  const minSize = Math.min(...sizes);
  if (maxSize - minSize <= 1) return inputs.map(() => 0);
  const baseline = options?.baseline ?? baselineFontSize(inputs);
  const levels = inputs.map((input): HeadingLevel => {
    const ratio = baseline > 0 ? input.fontSize / baseline : 0;
    let level: HeadingLevel = ratio >= HEADING_LEVEL_RATIOS[1]
      ? 1
      : ratio >= HEADING_LEVEL_RATIOS[2]
        ? 2
        : ratio >= HEADING_LEVEL_RATIOS[3]
          ? 3
          : 0;
    if (level !== 0 && (
      input.lineCount !== 1
      || input.text.length > 80
      || /[\u3002\uff01\uff1f.!?;；]\s*$/u.test(input.text)
    )) {
      level = 0;
    }
    return level;
  });
  if (levels.filter((level) => level > 0).length > 6) return inputs.map(() => 0);
  return levels;
}
