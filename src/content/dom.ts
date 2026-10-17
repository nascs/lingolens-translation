export const CANDIDATE_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt";
export const EXCLUDED_SELECTOR = "script,style,noscript,code,pre,textarea,input,select,button,nav,header,footer,[contenteditable='true'],[aria-hidden='true'],.lingolens-owned";
const CONTENT_ROOT_SELECTOR = "main,[role='main'],article";
const FALLBACK_SELECTOR = "a,span,div,[role='cell'],[role='gridcell']";
const INLINE_CONTENT_BLOCK_SELECTOR = "div,section,td,th,[role='cell'],[role='gridcell']";
const COVERED_ANCESTOR_DEPTH = 16;

export const MAX_INSERT_LEVELS = 8;

const INLINE_LIKE = new Set([
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "contents",
  "ruby",
  "ruby-base",
  "ruby-text"
]);

const DANGEROUS_PARENT = new Set([...INLINE_LIKE, "flex", "grid", "-webkit-box"]);

const SAFE_BLOCK = new Set(["block", "flow-root", "list-item", "flex", "grid", "table", "-webkit-box"]);

const TOP_BOUNDARY_TAGS = new Set(["HTML", "BODY", "MAIN", "ARTICLE"]);

export interface EligibilityInput {
  tagName: string;
  text: string;
  isExcluded: boolean;
  containsCandidate: boolean;
  isOwned: boolean;
}

export function isEligibleText(input: EligibilityInput): boolean {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (input.isExcluded || input.containsCandidate || input.isOwned) return false;
  if (text.length < 12 || text.length > 4000) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  return input.tagName.toLowerCase() !== "code";
}

export function looksLikeTranslatableSentence(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 18 || normalized.length > 4000) return false;
  if (/^(?:https?:\/\/|[\w.-]+\/[\w./-]+$)/i.test(normalized)) return false;
  const containsCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized);
  if (!containsCjk && !/\s/u.test(normalized)) return false;
  const latinWords = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  const cjkCharacters = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  return latinWords >= 3 || cjkCharacters >= 6;
}

export interface LevelInfo {
  tagName: string;
  display: string;
  parentDisplay: string;
  lineClamp: string;
  clipsOverflow: boolean;
  hasLinkContext: boolean;
  isScopeBoundary: boolean;
}

function clampActive(lineClamp: string): boolean {
  const value = lineClamp.trim().toLowerCase();
  return value !== "" && value !== "none" && value !== "0";
}

function canStopAtInlineLink(level: LevelInfo): boolean {
  return level.tagName === "A"
    && !level.hasLinkContext
    && (level.parentDisplay === "block" || level.parentDisplay === "flow-root" || level.parentDisplay === "list-item");
}

/** 依据祖先链决定插入下标的纯决策：越靠外的安全层级优先，任何裁切祖先或危险父都会继续上溯。 */
export function resolveInsertAnchor(levels: readonly LevelInfo[], fallbackTag: string): number {
  const limit = Math.min(levels.length, MAX_INSERT_LEVELS);
  if (limit === 0) return 0;
  if (levels[0]!.tagName !== fallbackTag) return 0;

  const hasClippingAncestor: boolean[] = new Array<boolean>(limit).fill(false);
  let outerClipped = false;
  for (let index = limit - 1; index >= 0; index -= 1) {
    hasClippingAncestor[index] = outerClipped;
    const level = levels[index]!;
    outerClipped = outerClipped || clampActive(level.lineClamp) || level.clipsOverflow;
  }

  for (let index = 0; index < limit; index += 1) {
    const level = levels[index]!;
    if (level.isScopeBoundary) break;
    if (hasClippingAncestor[index]) continue;
    if (INLINE_LIKE.has(level.display)) {
      if (canStopAtInlineLink(level)) return index;
      continue;
    }
    if (DANGEROUS_PARENT.has(level.parentDisplay)) continue;
    if (level.hasLinkContext) continue;
    if (!SAFE_BLOCK.has(level.display)) continue;
    return index;
  }
  return 0;
}

export interface BlockAxisClipInput {
  writingMode: string;
  overflowX: string;
  overflowY: string;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  hasExplicitBlockConstraint: boolean;
}

const VERTICAL_BLOCK_PROPERTIES: readonly string[] = ["width", "block-size", "max-width", "max-block-size"];
const HORIZONTAL_BLOCK_PROPERTIES: readonly string[] = ["height", "block-size", "max-height", "max-block-size"];

function isVerticalWritingMode(writingMode: string): boolean {
  const value = writingMode.trim().toLowerCase();
  return value.startsWith("vertical-") || value.startsWith("sideways-");
}

export function blockAxisExplicitProperties(writingMode: string): readonly string[] {
  return isVerticalWritingMode(writingMode) ? VERTICAL_BLOCK_PROPERTIES : HORIZONTAL_BLOCK_PROPERTIES;
}

/** 按书写模式挑出块轴，横向用 y、竖向用 x，只有裁切隐藏且确有溢出（或有显式块轴约束）才算裁切。 */
export function resolveBlockAxisClip(input: BlockAxisClipInput): boolean {
  const vertical = isVerticalWritingMode(input.writingMode);
  const overflow = vertical ? input.overflowX : input.overflowY;
  if (overflow !== "hidden" && overflow !== "clip") return false;
  const scroll = vertical ? input.scrollWidth : input.scrollHeight;
  const client = vertical ? input.clientWidth : input.clientHeight;
  return scroll > client + 1 || input.hasExplicitBlockConstraint;
}

export function shouldSkipFallbackLink(tagName: string, containsSelectedSemantic: boolean): boolean {
  return tagName === "A" && containsSelectedSemantic;
}

export function fragmentPromotionLimit(candidateLength: number): number {
  return Math.min(4000, candidateLength * 3 + 120);
}

const BLOCKIFIED_FLEX_PARENT = new Set(["flex", "inline-flex", "grid", "inline-grid"]);

/** 仅把 flex/grid 盒中块化的 SPAN 认作内联碎片，避免把普通块级元素当成可聚合碎片。 */
export function isBlockifiedFlexFragment(tagName: string, display: string, nearestBoxAncestorDisplay: string): boolean {
  return tagName === "SPAN" && display === "block" && BLOCKIFIED_FLEX_PARENT.has(nearestBoxAncestorDisplay);
}

export interface FragmentPromotionInput {
  candidateDisplay: string;
  candidateBlockifiedFragment: boolean;
  containerDisplay: string;
  candidateLength: number;
  containerLength: number;
  hasLetterOrDigit: boolean;
  candidateVisible: boolean;
  containerVisible: boolean;
  candidateExcluded: boolean;
  containerExcluded: boolean;
  containerIsTopBoundary: boolean;
  containerHasAnyCandidateDescendant: boolean;
  containerHasSelectedSemantic: boolean;
}

export function isInlineLevelChild(tagName: string, display: string, nearestBoxAncestorDisplay: string): boolean {
  if (display === "none") return true;
  if (INLINE_LIKE.has(display)) return true;
  return isBlockifiedFlexFragment(tagName, display, nearestBoxAncestorDisplay);
}

export interface InlineContentBlockInput {
  excluded: boolean;
  owned: boolean;
  visible: boolean;
  covered: boolean;
  hasOwnedDescendant: boolean;
  hasSemanticCandidateDescendant: boolean;
  hasBlockLevelChild: boolean;
  text: string;
}

/** 行内内容块：子元素全为行内级（或隐藏/被块化的行内碎片）且内部无更细候选的块容器，整块作为一个翻译单元。 */
export function shouldCollectInlineContentBlock(input: InlineContentBlockInput): boolean {
  if (input.excluded || input.owned || !input.visible || input.covered) return false;
  if (input.hasOwnedDescendant || input.hasSemanticCandidateDescendant || input.hasBlockLevelChild) return false;
  return looksLikeTranslatableSentence(input.text);
}

export function shouldPromoteFallbackFragment(input: FragmentPromotionInput): boolean {
  if (!INLINE_LIKE.has(input.candidateDisplay) && !input.candidateBlockifiedFragment) return false;
  if (!SAFE_BLOCK.has(input.containerDisplay)) return false;
  if (!input.hasLetterOrDigit || !input.candidateVisible || !input.containerVisible) return false;
  if (input.candidateExcluded || input.containerExcluded) return false;
  if (input.containerIsTopBoundary || input.containerHasAnyCandidateDescendant || input.containerHasSelectedSemantic) return false;
  return input.candidateLength <= input.containerLength
    && input.containerLength <= fragmentPromotionLimit(input.candidateLength);
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function isTopBoundary(element: Element): boolean {
  return TOP_BOUNDARY_TAGS.has(element.tagName) || element.getAttribute("role") === "main";
}

function withinRoot(root: ParentNode, node: Element): boolean {
  const nodeContainer = root as Node;
  return nodeContainer === node || nodeContainer.contains(node);
}

function selectSemanticLinks(semanticElements: Set<HTMLElement>, root: ParentNode): WeakSet<HTMLElement> {
  const links = new WeakSet<HTMLElement>();
  for (const element of semanticElements) {
    for (let current = element.parentElement; current && withinRoot(root, current); current = current.parentElement) {
      if (current.tagName === "A") links.add(current);
    }
  }
  return links;
}

function findPromotionContainer(
  candidate: HTMLElement,
  root: ParentNode,
  displayOf: (element: HTMLElement) => string
): HTMLElement | null {
  for (let current = candidate.parentElement; current && withinRoot(root, current); current = current.parentElement) {
    if (isTopBoundary(current)) return null;
    if (SAFE_BLOCK.has(displayOf(current))) return current;
  }
  return null;
}

function hasBlockLevelChildElement(element: HTMLElement, displayOf: (element: HTMLElement) => string): boolean {
  for (const child of Array.from(element.children) as HTMLElement[]) {
    if (isInlineLevelChild(child.tagName, displayOf(child), nearestAncestorDisplay(child, displayOf))) continue;
    return true;
  }
  return false;
}

function nearestAncestorDisplay(candidate: HTMLElement, displayOf: (element: HTMLElement) => string): string {
  for (let current = candidate.parentElement; current; current = current.parentElement) {
    const display = displayOf(current);
    if (display !== "contents") return display;
  }
  return "";
}

function aggregateFallbackCandidate(
  candidate: HTMLElement,
  semanticElements: Set<HTMLElement>,
  root: ParentNode,
  visible: (element: HTMLElement) => boolean,
  displayOf: (element: HTMLElement) => string
): HTMLElement | null {
  const candidateDisplay = displayOf(candidate);
  const blockified = isBlockifiedFlexFragment(candidate.tagName, candidateDisplay, nearestAncestorDisplay(candidate, displayOf));
  if (!INLINE_LIKE.has(candidateDisplay) && !blockified) return null;
  const container = findPromotionContainer(candidate, root, displayOf);
  if (!container) return null;
  const candidateText = normalizedElementText(candidate);
  const containerText = normalizedElementText(container);
  const candidateDescendants = container.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR);
  const promoted = shouldPromoteFallbackFragment({
    candidateDisplay,
    candidateBlockifiedFragment: blockified,
    containerDisplay: displayOf(container),
    candidateLength: candidateText.length,
    containerLength: containerText.length,
    hasLetterOrDigit: /[\p{L}\p{N}]/u.test(candidateText),
    candidateVisible: visible(candidate),
    containerVisible: visible(container),
    candidateExcluded: Boolean(candidate.closest(EXCLUDED_SELECTOR)),
    containerExcluded: Boolean(container.closest(EXCLUDED_SELECTOR)),
    containerIsTopBoundary: isTopBoundary(container),
    containerHasAnyCandidateDescendant: candidateDescendants.length > 0,
    containerHasSelectedSemantic: Array.from(candidateDescendants).some((element) => semanticElements.has(element))
  });
  return promoted ? container : null;
}

function collectFallbackElements(semanticElements: Set<HTMLElement>, root: ParentNode): HTMLElement[] {
  const contentRoots = Array.from(root.querySelectorAll<HTMLElement>(CONTENT_ROOT_SELECTOR));
  const scopes = contentRoots.length > 0 ? contentRoots : root instanceof Document ? [root.body] : [];
  const fallback = new Set<HTMLElement>();
  const coveredAncestors = new WeakSet<HTMLElement>();
  const selectedLinks = selectSemanticLinks(semanticElements, root);
  const visibilityCache = new WeakMap<HTMLElement, boolean>();
  const displayCache = new WeakMap<HTMLElement, string>();

  const visible = (element: HTMLElement): boolean => {
    const cached = visibilityCache.get(element);
    if (cached !== undefined) return cached;
    const value = isVisible(element);
    visibilityCache.set(element, value);
    return value;
  };

  const displayOf = (element: HTMLElement): string => {
    const cached = displayCache.get(element);
    if (cached !== undefined) return cached;
    const value = getComputedStyle(element).display;
    displayCache.set(element, value);
    return value;
  };

  // 已选候选的祖先块不再做整块收集，避免同一段文字被翻译两次。
  const markCoveredAncestors = (element: HTMLElement): void => {
    let current = element.parentElement;
    let depth = 0;
    while (current && depth < COVERED_ANCESTOR_DEPTH && withinRoot(root, current)) {
      coveredAncestors.add(current);
      current = current.parentElement;
      depth += 1;
    }
  };

  for (const scope of scopes) {
    for (const leaf of scope.querySelectorAll<HTMLElement>(FALLBACK_SELECTOR)) {
      const candidate = leaf.closest<HTMLElement>("a") ?? leaf;
      if (shouldSkipFallbackLink(candidate.tagName, candidate.tagName === "A" && selectedLinks.has(candidate))) continue;
      if (fallback.has(candidate) || candidate.children.length > 0 && candidate.tagName !== "A") continue;
      if (candidate.closest(EXCLUDED_SELECTOR) || !visible(candidate)) continue;
      const semanticAncestor = candidate.closest<HTMLElement>(CANDIDATE_SELECTOR);
      if (semanticAncestor && semanticElements.has(semanticAncestor)) continue;
      const target = aggregateFallbackCandidate(candidate, semanticElements, root, visible, displayOf) ?? candidate;
      if (fallback.has(target)) continue;
      if (!looksLikeTranslatableSentence(target.innerText || target.textContent || "")) continue;
      fallback.add(target);
      markCoveredAncestors(target);
    }
  }

  // 第二阶段：行内内容块（子元素全为行内级、内部无更细候选/译文/排除），例如只含 <b>/<em> 的摘要块。
  for (const scope of scopes) {
    for (const block of scope.querySelectorAll<HTMLElement>(INLINE_CONTENT_BLOCK_SELECTOR)) {
      // 结构预筛（与 shouldCollectInlineContentBlock 同义，先行短路以控制每轮扫描成本）。
      if (fallback.has(block) || coveredAncestors.has(block)) continue;
      if (block.closest(EXCLUDED_SELECTOR) || block.classList.contains("lingolens-owned")) continue;
      if (!visible(block)) continue;
      if (hasBlockLevelChildElement(block, displayOf)) continue;
      if (block.querySelector(".lingolens-owned")) continue;
      if (block.querySelector(CANDIDATE_SELECTOR)) continue;
      const input: InlineContentBlockInput = {
        excluded: false,
        owned: false,
        visible: true,
        covered: false,
        hasOwnedDescendant: false,
        hasSemanticCandidateDescendant: false,
        hasBlockLevelChild: false,
        text: block.innerText || block.textContent || ""
      };
      if (!shouldCollectInlineContentBlock(input)) continue;
      fallback.add(block);
    }
  }

  return Array.from(fallback);
}

export function collectTranslatableElements(root: ParentNode = document): HTMLElement[] {
  const semantic = Array.from(root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)).filter((element) =>
    isEligibleText({
      tagName: element.tagName,
      text: element.innerText || element.textContent || "",
      isExcluded: Boolean(element.closest(EXCLUDED_SELECTOR)),
      containsCandidate: Boolean(element.querySelector(CANDIDATE_SELECTOR)),
      isOwned: element.classList.contains("lingolens-owned")
    }) && isVisible(element)
  );
  return [...semantic, ...collectFallbackElements(new Set(semantic), root)];
}

export function normalizedElementText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
}

function declaresBlockConstraint(element: HTMLElement, writingMode: string): boolean {
  const properties = blockAxisExplicitProperties(writingMode);
  const declared: string[] = [];
  try {
    const computed = element.computedStyleMap?.();
    if (computed) {
      for (const property of properties) {
        const value = computed.get(property);
        if (value) declared.push(value.toString());
      }
    }
  } catch {
    // computedStyleMap 缺失或不可用时退回到 inline 声明判断。
  }
  if (declared.length === 0) {
    for (const property of properties) {
      const value = element.style.getPropertyValue(property);
      if (value) declared.push(value);
    }
  }
  return declared.some((value) => {
    const normalized = value.trim().toLowerCase();
    return normalized !== "" && normalized !== "auto" && normalized !== "none";
  });
}

function clipsOverflow(element: HTMLElement, style: CSSStyleDeclaration): boolean {
  return resolveBlockAxisClip({
    writingMode: style.writingMode,
    overflowX: style.overflowX,
    overflowY: style.overflowY,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    hasExplicitBlockConstraint: declaresBlockConstraint(element, style.writingMode)
  });
}

/** 把元素及其祖先（含首个 scope boundary 层，最多 MAX_INSERT_LEVELS 层）读成决策输入，并返回插入锚点。 */
export function resolveTranslationInsertAnchor(element: HTMLElement): HTMLElement {
  const chain: HTMLElement[] = [];
  let current: HTMLElement | null = element;
  while (current && chain.length < MAX_INSERT_LEVELS) {
    chain.push(current);
    if (isTopBoundary(current)) break;
    current = current.parentElement;
  }

  const styles = chain.map((node) => getComputedStyle(node));
  const levels: LevelInfo[] = chain.map((node, index) => {
    const style = styles[index]!;
    const parent = node.parentElement;
    return {
      tagName: node.tagName,
      display: style.display,
      parentDisplay: styles[index + 1]?.display ?? (parent ? getComputedStyle(parent).display : ""),
      lineClamp: style.webkitLineClamp,
      clipsOverflow: clipsOverflow(node, style),
      hasLinkContext: node.tagName !== "A" && Boolean(node.closest("a")),
      isScopeBoundary: isTopBoundary(node)
    };
  });

  const anchor = chain[resolveInsertAnchor(levels, element.tagName)];
  return anchor && anchor.isConnected ? anchor : element;
}
