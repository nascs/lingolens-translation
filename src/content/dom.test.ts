import { describe, expect, it } from "vitest";
import {
  MAX_INSERT_LEVELS,
  blockAxisExplicitProperties,
  fragmentPromotionLimit,
  isEligibleText,
  isBlockifiedFlexFragment,
  isInlineLevelChild,
  looksLikeTranslatableSentence,
  resolveBlockAxisClip,
  resolveInsertAnchor,
  shouldCollectInlineContentBlock,
  shouldPromoteFallbackFragment,
  shouldSkipFallbackLink,
  type BlockAxisClipInput,
  type FragmentPromotionInput,
  type InlineContentBlockInput,
  type LevelInfo
} from "./dom";

describe("isEligibleText", () => {
  const base = { tagName: "p", isExcluded: false, containsCandidate: false, isOwned: false };

  it("accepts readable paragraphs", () => {
    expect(isEligibleText({ ...base, text: "A useful paragraph with enough words." })).toBe(true);
  });

  it("rejects short, excluded, nested, and extension-owned content", () => {
    expect(isEligibleText({ ...base, text: "short" })).toBe(false);
    expect(isEligibleText({ ...base, text: "A useful paragraph", isExcluded: true })).toBe(false);
    expect(isEligibleText({ ...base, text: "A useful paragraph", containsCandidate: true })).toBe(false);
    expect(isEligibleText({ ...base, text: "A useful paragraph", isOwned: true })).toBe(false);
  });

  it("honours the 12..4000 length window", () => {
    expect(isEligibleText({ ...base, text: "a".repeat(11) })).toBe(false);
    expect(isEligibleText({ ...base, text: "a".repeat(12) })).toBe(true);
    expect(isEligibleText({ ...base, text: "a".repeat(4000) })).toBe(true);
    expect(isEligibleText({ ...base, text: "a".repeat(4001) })).toBe(false);
  });
});

describe("looksLikeTranslatableSentence", () => {
  it("accepts commit descriptions and natural language", () => {
    expect(looksLikeTranslatableSentence("arm64: dts: qcom: add fan controller support")).toBe(true);
    expect(looksLikeTranslatableSentence("This documentation explains the camera interface.")).toBe(true);
  });

  it("rejects paths, short labels, and file names", () => {
    expect(looksLikeTranslatableSentence("drivers/media/platform")).toBe(false);
    expect(looksLikeTranslatableSentence("Documentation")).toBe(false);
    expect(looksLikeTranslatableSentence("Ubuntu-qcom-6.8.0-1066.67")).toBe(false);
  });
});

const level = (values: Partial<LevelInfo> & { tagName: string }): LevelInfo => ({
  display: "block",
  parentDisplay: "block",
  lineClamp: "none",
  clipsOverflow: false,
  hasLinkContext: false,
  isScopeBoundary: false,
  ...values
});

interface AnchorCase {
  name: string;
  levels: LevelInfo[];
  expected: number;
  fallbackTag?: string;
}

describe("resolveInsertAnchor", () => {
  const cases: AnchorCase[] = [
    {
      name: "a plain paragraph",
      levels: [level({ tagName: "P" })],
      expected: 0
    },
    {
      name: "an inline link nested in a safe block",
      levels: [level({ tagName: "A", display: "inline" })],
      expected: 0
    },
    {
      name: "a result heading wrapped by an inline-block link",
      levels: [
        level({ tagName: "H3", parentDisplay: "inline-block", hasLinkContext: true }),
        level({ tagName: "A", display: "inline-block" }),
        level({ tagName: "DIV" })
      ],
      expected: 1
    },
    {
      name: "a span shadowed by an ancestor line clamp",
      levels: [level({ tagName: "SPAN", display: "inline" }), level({ tagName: "DIV", lineClamp: "3" })],
      expected: 1
    },
    {
      name: "the clipped container itself",
      levels: [level({ tagName: "DIV", lineClamp: "3" })],
      expected: 0
    },
    {
      name: "a flex child",
      levels: [level({ tagName: "DIV", parentDisplay: "flex" }), level({ tagName: "DIV", display: "flex" })],
      expected: 1
    },
    {
      name: "the flex container itself",
      levels: [level({ tagName: "DIV", display: "flex" })],
      expected: 0
    },
    {
      name: "a grid child",
      levels: [level({ tagName: "DIV", parentDisplay: "grid" }), level({ tagName: "DIV", display: "grid" })],
      expected: 1
    },
    {
      name: "a -webkit-box child",
      levels: [
        level({ tagName: "DIV", parentDisplay: "-webkit-box" }),
        level({ tagName: "DIV", display: "-webkit-box" })
      ],
      expected: 1
    },
    {
      name: "an inline-flex child promoted two levels up",
      levels: [
        level({ tagName: "DIV", parentDisplay: "inline-flex" }),
        level({ tagName: "DIV", display: "inline-flex" }),
        level({ tagName: "DIV" })
      ],
      expected: 2
    },
    {
      name: "a paragraph hanging directly under body",
      levels: [level({ tagName: "P" }), level({ tagName: "BODY", isScopeBoundary: true })],
      expected: 0
    },
    {
      name: "a chain whose boundary precedes the safe block",
      levels: [
        level({ tagName: "DIV", parentDisplay: "grid" }),
        level({ tagName: "MAIN", isScopeBoundary: true }),
        level({ tagName: "DIV", display: "flex" })
      ],
      expected: 0
    },
    {
      name: "a chain whose only safe level sits beyond the level cap",
      levels: [
        ...Array.from({ length: MAX_INSERT_LEVELS }, () =>
          level({ tagName: "SPAN", display: "inline", parentDisplay: "inline" })),
        level({ tagName: "DIV" })
      ],
      expected: 0
    },
    {
      name: "a chain whose first tag differs from the fallback tag",
      levels: [level({ tagName: "SPAN", display: "inline" })],
      expected: 0,
      fallbackTag: "P"
    }
  ];

  for (const testCase of cases) {
    it(`stops at level ${testCase.expected} for ${testCase.name}`, () => {
      const fallbackTag = testCase.fallbackTag ?? testCase.levels[0]!.tagName;
      expect(resolveInsertAnchor(testCase.levels, fallbackTag)).toBe(testCase.expected);
    });
  }

  it("returns zero for an empty chain and caps the walk at eight levels", () => {
    expect(MAX_INSERT_LEVELS).toBe(8);
    expect(resolveInsertAnchor([], "P")).toBe(0);
  });

  it("keeps ascending past a block element that already sits inside a link", () => {
    const levels = [level({ tagName: "P", hasLinkContext: true }), level({ tagName: "DIV" })];
    expect(resolveInsertAnchor(levels, "P")).toBe(1);
  });
});

describe("resolveInsertAnchor boundaries", () => {
  for (const danger of ["flex", "grid", "-webkit-box"]) {
    it(`never stops at an inline link inside a ${danger} parent`, () => {
      const levels = [
        level({ tagName: "A", display: "inline", parentDisplay: danger }),
        level({ tagName: "DIV", display: danger }),
        level({ tagName: "DIV" })
      ];
      const index = resolveInsertAnchor(levels, "A");
      expect(index).not.toBe(0);
      expect(index).toBe(1);
    });
  }

  it("skips an inline link shadowed by an outer line clamp", () => {
    const levels = [
      level({ tagName: "A", display: "inline" }),
      level({ tagName: "DIV" }),
      level({ tagName: "DIV", lineClamp: "2" }),
      level({ tagName: "DIV" })
    ];
    expect(resolveInsertAnchor(levels, "A")).toBe(2);
  });

  it("stops at a clipping container instead of an inline link above it", () => {
    const levels = [
      level({ tagName: "A", display: "inline" }),
      level({ tagName: "DIV" }),
      level({ tagName: "DIV", clipsOverflow: true }),
      level({ tagName: "DIV" })
    ];
    expect(levels[2]!.clipsOverflow).toBe(true);
    expect(resolveInsertAnchor(levels, "A")).toBe(2);
  });
});

const clipInput = (values: Partial<BlockAxisClipInput>): BlockAxisClipInput => ({
  writingMode: "horizontal-tb",
  overflowX: "visible",
  overflowY: "visible",
  scrollWidth: 100,
  clientWidth: 100,
  scrollHeight: 100,
  clientHeight: 100,
  hasExplicitBlockConstraint: false,
  ...values
});

describe("resolveBlockAxisClip", () => {
  it("flags horizontal blocks that clip more than one pixel of block flow", () => {
    expect(resolveBlockAxisClip(clipInput({ overflowY: "hidden", scrollHeight: 102 }))).toBe(true);
    expect(resolveBlockAxisClip(clipInput({ overflowY: "clip", scrollHeight: 102 }))).toBe(true);
  });

  it("ignores rounding, inline-axis overflow, and non-clipping overflow values", () => {
    expect(resolveBlockAxisClip(clipInput({ overflowY: "hidden", scrollHeight: 101 }))).toBe(false);
    expect(resolveBlockAxisClip(clipInput({ overflowX: "hidden", scrollHeight: 160 }))).toBe(false);
    expect(resolveBlockAxisClip(clipInput({ overflowY: "visible", scrollHeight: 160 }))).toBe(false);
    expect(resolveBlockAxisClip(clipInput({ overflowY: "auto", scrollHeight: 160 }))).toBe(false);
  });

  it("uses the inline axis for vertical writing modes", () => {
    expect(resolveBlockAxisClip(clipInput({ writingMode: "vertical-rl", overflowX: "hidden", scrollWidth: 120 }))).toBe(true);
    expect(resolveBlockAxisClip(clipInput({ writingMode: "sideways-lr", overflowX: "clip", scrollWidth: 140 }))).toBe(true);
    expect(resolveBlockAxisClip(clipInput({ writingMode: "vertical-rl", overflowY: "hidden", scrollHeight: 200 }))).toBe(false);
  });

  it("needs an explicit block constraint when nothing actually overflows", () => {
    expect(resolveBlockAxisClip(clipInput({ writingMode: "vertical-rl", overflowX: "hidden" }))).toBe(false);
    expect(resolveBlockAxisClip(clipInput({ overflowY: "hidden", hasExplicitBlockConstraint: true }))).toBe(true);
    expect(
      resolveBlockAxisClip(clipInput({ writingMode: "vertical-rl", overflowX: "hidden", hasExplicitBlockConstraint: true }))
    ).toBe(true);
    expect(resolveBlockAxisClip(clipInput({ hasExplicitBlockConstraint: true }))).toBe(false);
  });
});

describe("blockAxisExplicitProperties", () => {
  it("returns the exact property set for each axis", () => {
    expect(blockAxisExplicitProperties("vertical-rl")).toEqual(["width", "block-size", "max-width", "max-block-size"]);
    expect(blockAxisExplicitProperties("sideways-rl")).toEqual(["width", "block-size", "max-width", "max-block-size"]);
    expect(blockAxisExplicitProperties("horizontal-tb")).toEqual(["height", "block-size", "max-height", "max-block-size"]);
    expect(blockAxisExplicitProperties("")).toEqual(["height", "block-size", "max-height", "max-block-size"]);
  });

  it("never treats inline-size as a block constraint", () => {
    for (const writingMode of ["vertical-rl", "horizontal-tb", ""]) {
      const properties = blockAxisExplicitProperties(writingMode);
      expect(properties).toHaveLength(4);
      expect(properties).not.toContain("inline-size");
      expect(properties).not.toContain("max-inline-size");
    }
  });
});

describe("shouldSkipFallbackLink", () => {
  it("skips only links that carry a selected semantic element", () => {
    expect(shouldSkipFallbackLink("A", true)).toBe(true);
    expect(shouldSkipFallbackLink("A", false)).toBe(false);
    expect(shouldSkipFallbackLink("SPAN", true)).toBe(false);
    expect(shouldSkipFallbackLink("DIV", true)).toBe(false);
  });

  it("keeps short headings translatable through their link while long headings stay protected", () => {
    const shared = { isExcluded: false, containsCandidate: false, isOwned: false };
    expect(isEligibleText({ ...shared, tagName: "h3", text: "Short" })).toBe(false);
    expect(shouldSkipFallbackLink("A", false)).toBe(false);
    expect(isEligibleText({ ...shared, tagName: "h3", text: "A long heading that passes the eligibility floor" })).toBe(true);
    expect(shouldSkipFallbackLink("A", true)).toBe(true);
  });
});

describe("isBlockifiedFlexFragment", () => {
  it("accepts only SPAN children blockified by flex or grid box ancestors", () => {
    expect(isBlockifiedFlexFragment("SPAN", "block", "flex")).toBe(true);
    expect(isBlockifiedFlexFragment("SPAN", "block", "inline-flex")).toBe(true);
    expect(isBlockifiedFlexFragment("SPAN", "block", "grid")).toBe(true);
    expect(isBlockifiedFlexFragment("SPAN", "block", "inline-grid")).toBe(true);
  });

  it("rejects non-box ancestors, non-block displays, and other tags", () => {
    expect(isBlockifiedFlexFragment("SPAN", "block", "block")).toBe(false);
    expect(isBlockifiedFlexFragment("SPAN", "block", "contents")).toBe(false);
    expect(isBlockifiedFlexFragment("SPAN", "inline", "flex")).toBe(false);
    expect(isBlockifiedFlexFragment("DIV", "block", "flex")).toBe(false);
    expect(isBlockifiedFlexFragment("A", "block", "flex")).toBe(false);
  });
});

describe("fragmentPromotionLimit", () => {
  it("scales with the candidate length and caps at 4000", () => {
    expect(fragmentPromotionLimit(20)).toBe(180);
    expect(fragmentPromotionLimit(100)).toBe(420);
    expect(fragmentPromotionLimit(2000)).toBe(4000);
  });
});

describe("isInlineLevelChild", () => {
  it("accepts inline, hidden, and blockified fragment children", () => {
    expect(isInlineLevelChild("B", "inline", "block")).toBe(true);
    expect(isInlineLevelChild("EM", "inline", "block")).toBe(true);
    expect(isInlineLevelChild("B", "none", "block")).toBe(true);
    expect(isInlineLevelChild("SPAN", "block", "flex")).toBe(true);
    expect(isInlineLevelChild("SPAN", "block", "grid")).toBe(true);
  });

  it("rejects block-level children and non-flex blockified spans", () => {
    expect(isInlineLevelChild("DIV", "block", "block")).toBe(false);
    expect(isInlineLevelChild("DIV", "list-item", "block")).toBe(false);
    expect(isInlineLevelChild("SPAN", "block", "block")).toBe(false);
    expect(isInlineLevelChild("A", "block", "flex")).toBe(false);
  });
});

describe("shouldCollectInlineContentBlock", () => {
  const block = (values: Partial<InlineContentBlockInput> = {}): InlineContentBlockInput => ({
    excluded: false,
    owned: false,
    visible: true,
    covered: false,
    hasOwnedDescendant: false,
    hasSemanticCandidateDescendant: false,
    hasBlockLevelChild: false,
    text: "The Linux kernel is a free and open-source monolithic kernel maintained by contributors.",
    ...values
  });

  it("collects an inline-only block with a translatable sentence", () => {
    expect(shouldCollectInlineContentBlock(block())).toBe(true);
  });

  it("rejects structural negatives", () => {
    expect(shouldCollectInlineContentBlock(block({ excluded: true }))).toBe(false);
    expect(shouldCollectInlineContentBlock(block({ owned: true }))).toBe(false);
    expect(shouldCollectInlineContentBlock(block({ visible: false }))).toBe(false);
    expect(shouldCollectInlineContentBlock(block({ covered: true }))).toBe(false);
    expect(shouldCollectInlineContentBlock(block({ hasOwnedDescendant: true }))).toBe(false);
    expect(shouldCollectInlineContentBlock(block({ hasSemanticCandidateDescendant: true }))).toBe(false);
    expect(shouldCollectInlineContentBlock(block({ hasBlockLevelChild: true }))).toBe(false);
  });

  it("rejects short or oversized text", () => {
    expect(shouldCollectInlineContentBlock(block({ text: "Too short." }))).toBe(false);
    expect(shouldCollectInlineContentBlock(block({ text: "word ".repeat(1000) }))).toBe(false);
  });
});

describe("shouldPromoteFallbackFragment", () => {
  const promotion = (values: Partial<FragmentPromotionInput>): FragmentPromotionInput => ({
    candidateDisplay: "inline-block",
    candidateBlockifiedFragment: false,
    containerDisplay: "block",
    candidateLength: 20,
    containerLength: 40,
    hasLetterOrDigit: true,
    candidateVisible: true,
    containerVisible: true,
    candidateExcluded: false,
    containerExcluded: false,
    containerIsTopBoundary: false,
    containerHasAnyCandidateDescendant: false,
    containerHasSelectedSemantic: false,
    ...values
  });

  it("promotes an inline fragment into a larger safe block container", () => {
    expect(shouldPromoteFallbackFragment(promotion({}))).toBe(true);
    expect(shouldPromoteFallbackFragment(promotion({ candidateDisplay: "inline" }))).toBe(true);
    for (const containerDisplay of ["flow-root", "flex", "grid", "block", "list-item", "table"]) {
      expect(shouldPromoteFallbackFragment(promotion({ containerDisplay }))).toBe(true);
    }
  });

  it("rejects containers and candidates that are not inline/safe blocks", () => {
    expect(shouldPromoteFallbackFragment(promotion({ containerDisplay: "inline-flex" }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ containerDisplay: "contents" }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ containerDisplay: "" }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ candidateDisplay: "block" }))).toBe(false);
  });

  it("treats a blockified flex/grid fragment as an inline candidate", () => {
    expect(
      shouldPromoteFallbackFragment(promotion({ candidateDisplay: "block", candidateBlockifiedFragment: true, containerDisplay: "flex" }))
    ).toBe(true);
    expect(
      shouldPromoteFallbackFragment(promotion({ candidateDisplay: "block", candidateBlockifiedFragment: false, containerDisplay: "flex" }))
    ).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ candidateDisplay: "block" }))).toBe(false);
  });

  it("rejects oversized, inverted, and empty fragments", () => {
    expect(shouldPromoteFallbackFragment(promotion({ containerLength: 181 }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ candidateLength: 2000, containerLength: 4001 }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ candidateLength: 2000, containerLength: 4000 }))).toBe(true);
    expect(shouldPromoteFallbackFragment(promotion({ candidateLength: 100, containerLength: 50 }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ candidateLength: 0, containerLength: 0, hasLetterOrDigit: false }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ hasLetterOrDigit: false }))).toBe(false);
  });

  it("rejects hidden, excluded, boundary, polluted, and already-selected containers", () => {
    expect(shouldPromoteFallbackFragment(promotion({ candidateVisible: false }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ containerVisible: false }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ candidateExcluded: true }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ containerExcluded: true }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ containerIsTopBoundary: true }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ containerHasAnyCandidateDescendant: true }))).toBe(false);
    expect(shouldPromoteFallbackFragment(promotion({ containerHasSelectedSemantic: true }))).toBe(false);
  });
});
