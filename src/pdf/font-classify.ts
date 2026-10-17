import type { SerifKind } from "./style";

export type { SerifKind };

const SERIF_TOKENS = [
  "times", "newroman", "tms", "georgia", "garamond", "baskerville", "caslon",
  "palatino", "bookantiqua", "bookman", "cambria", "charter", "didot", "bodoni",
  "minion", "sabon", "song", "sung", "simsun", "nsimsun", "ming", "mingliu",
  "pmingson", "songti", "stsong", "kaiti", "kai", "fangsong", "stfang", "serif"
];

const SANS_TOKENS = [
  "helvetica", "arial", "verdana", "tahoma", "trebuchet", "gill", "gillsans",
  "futura", "avantgarde", "centurygothic", "hei", "heiti", "yahei", "msyh",
  "pingfang", "hiragino", "gothic", "notosans", "roboto", "segoe", "calibri",
  "candara", "corbel", "opensans", "lato", "montserrat", "sans", "arialmt",
  "helveticaneue"
];

const MONO_TOKENS = ["courier", "mono", "menlo", "consolas", "sourcecode", "dejavusansmono"];

export const SERIF_STACK = 'Georgia, "Noto Serif SC", "Songti SC", "SimSun", serif';
export const SANS_STACK = 'system-ui, -apple-system, "Segoe UI", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
export const MONOSPACE_STACK = 'ui-monospace, SFMono-Regular, monospace';

export function classifyFontFamily(fontFamily: string | undefined): SerifKind | undefined {
  if (!fontFamily) return undefined;
  const normalized = fontFamily.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (MONO_TOKENS.some((token) => normalized.includes(token))) return "sans";
  if (SANS_TOKENS.some((token) => normalized.includes(token))) return "sans";
  if (SERIF_TOKENS.some((token) => normalized.includes(token))) return "serif";
  return undefined;
}

export function serifStack(kind: SerifKind): string {
  return kind === "serif" ? SERIF_STACK : SANS_STACK;
}

export function weightedMedian(values: readonly { value: number; weight: number }[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) {
    const mid = sorted[Math.floor(sorted.length / 2)];
    return mid?.value ?? 0;
  }
  const half = total / 2;
  let accumulated = 0;
  for (const entry of sorted) {
    accumulated += entry.weight;
    if (accumulated >= half) return entry.value;
  }
  const last = sorted[sorted.length - 1];
  return last?.value ?? 0;
}

export function majoritySerif(votes: readonly { serif: SerifKind | undefined; chars: number }[]): SerifKind | undefined {
  let serif = 0;
  let sans = 0;
  for (const vote of votes) {
    if (vote.serif === "serif") serif += vote.chars;
    else if (vote.serif === "sans") sans += vote.chars;
  }
  if (serif === sans) return undefined;
  return serif > sans ? "serif" : "sans";
}
