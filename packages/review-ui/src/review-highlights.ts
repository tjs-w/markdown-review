import { MAX_TEXT_ANCHOR_CONTEXT_LENGTH, type ReviewTextAnchor } from "@markdown-review/contracts";

const HIGHLIGHT_NAME = "review-comments";

export interface ReviewHighlightAnchor {
  readonly id: string;
  readonly serial: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote: string;
  readonly textAnchor?: ReviewTextAnchor | undefined;
  readonly imageId?: string | undefined;
  readonly stale?: boolean | undefined;
}

export interface CapturedReviewTextAnchor {
  readonly quote: string;
  readonly textAnchor: ReviewTextAnchor;
}

interface SourceTextNode {
  readonly node: Text;
  readonly block: HTMLElement;
  readonly start: number;
  readonly end: number;
}

interface SourceIndex {
  readonly nodes: readonly SourceTextNode[];
  readonly source: string;
}

interface HighlightInterval {
  readonly anchor: ReviewHighlightAnchor;
  readonly start: number;
  readonly end: number;
}

interface CssHighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): boolean;
}

interface HighlightWindow extends Window {
  readonly CSS?: typeof CSS & { readonly highlights?: CssHighlightRegistry };
  readonly Highlight?: new (...ranges: Range[]) => unknown;
}

function blockContainsLine(block: HTMLElement, line: number): boolean {
  const start = Number(block.dataset["startLine"]);
  const end = Number(block.dataset["endLine"]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && line >= start && line <= end;
}

function unwrapFallbackHighlights(root: HTMLElement): void {
  const parents = new Set<Node>();
  for (const mark of root.querySelectorAll("mark.review-highlight")) {
    if (mark.parentNode) parents.add(mark.parentNode);
    mark.replaceWith(...mark.childNodes);
  }
  for (const parent of parents) parent.normalize();
}

function highlightRegistry(root: HTMLElement): CssHighlightRegistry | null {
  const view = root.ownerDocument.defaultView as HighlightWindow | null;
  return view?.CSS?.highlights ?? null;
}

export function clearReviewHighlights(root: HTMLElement): void {
  highlightRegistry(root)?.delete(HIGHLIGHT_NAME);
  unwrapFallbackHighlights(root);
}

function collectSourceText(root: HTMLElement): SourceIndex {
  const nodes: SourceTextNode[] = [];
  const sourceParts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let previousBlock: HTMLElement | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data) continue;
    const parent = node.parentElement;
    const block = parent?.closest<HTMLElement>(".review-block");
    if (!block || !root.contains(block) || parent?.closest("[data-review-ui], .local-image")) {
      continue;
    }
    if (previousBlock && previousBlock !== block) {
      sourceParts.push("\n");
      offset += 1;
    }
    const start = offset;
    sourceParts.push(node.data);
    offset += node.data.length;
    nodes.push({ node, block, start, end: offset });
    previousBlock = block;
  }
  return { nodes, source: sourceParts.join("") };
}

function boundaryOffset(
  root: HTMLElement,
  nodes: readonly SourceTextNode[],
  container: Node,
  localOffset: number,
): number | null {
  if (!Number.isSafeInteger(localOffset) || (container !== root && !root.contains(container))) {
    return null;
  }
  if (container instanceof Text) {
    const entry = nodes.find((candidate) => candidate.node === container);
    if (!entry || localOffset < 0 || localOffset > container.data.length) return null;
    return entry.start + localOffset;
  }
  if (
    !(container instanceof Element) ||
    localOffset < 0 ||
    localOffset > container.childNodes.length ||
    (container !== root && container.closest("[data-review-ui], .local-image"))
  ) {
    return null;
  }

  const point = root.ownerDocument.createRange();
  point.setStart(container, localOffset);
  point.collapse(true);
  for (const entry of nodes) {
    const text = root.ownerDocument.createRange();
    text.selectNodeContents(entry.node);
    if (point.compareBoundaryPoints(Range.START_TO_START, text) <= 0) return entry.start;
  }
  return nodes.at(-1)?.end ?? 0;
}

export function captureReviewTextAnchor(
  root: HTMLElement,
  range: Range,
): CapturedReviewTextAnchor | null {
  const index = collectSourceText(root);
  let start = boundaryOffset(root, index.nodes, range.startContainer, range.startOffset);
  let end = boundaryOffset(root, index.nodes, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;

  const selected = index.source.slice(start, end);
  const leading = /^\s*/u.exec(selected)?.[0].length ?? 0;
  const trailing = /\s*$/u.exec(selected)?.[0].length ?? 0;
  start += leading;
  end -= trailing;
  if (end <= start) return null;

  const quote = index.source.slice(start, end);
  return {
    quote,
    textAnchor: {
      version: 1,
      start,
      end,
      prefix: index.source.slice(Math.max(0, start - MAX_TEXT_ANCHOR_CONTEXT_LENGTH), start),
      suffix: index.source.slice(end, end + MAX_TEXT_ANCHOR_CONTEXT_LENGTH),
    },
  };
}

function allOccurrences(source: string, quote: string, start = 0, end = source.length): number[] {
  const output: number[] = [];
  if (!quote || end <= start || quote.length > end - start) return output;
  for (let offset = source.indexOf(quote, start); offset >= 0 && offset + quote.length <= end;) {
    output.push(offset);
    offset = source.indexOf(quote, offset + 1);
  }
  return output;
}

function intervalFromTextAnchor(
  index: SourceIndex,
  anchor: ReviewHighlightAnchor,
): HighlightInterval | null {
  const stored = anchor.textAnchor;
  if (!stored) return null;
  if (!anchor.stale) {
    return index.source.slice(stored.start, stored.end) === anchor.quote
      ? { anchor, start: stored.start, end: stored.end }
      : null;
  }

  const occurrences = allOccurrences(index.source, anchor.quote);
  if (occurrences.length === 1) {
    const start = occurrences[0];
    return start === undefined ? null : { anchor, start, end: start + anchor.quote.length };
  }
  const contextual = occurrences.filter((start) => {
    const prefixMatches = index.source.slice(0, start).endsWith(stored.prefix);
    const suffixMatches = index.source.slice(start + anchor.quote.length).startsWith(stored.suffix);
    return prefixMatches && suffixMatches;
  });
  const start = contextual.length === 1 ? contextual[0] : undefined;
  return start === undefined ? null : { anchor, start, end: start + anchor.quote.length };
}

function intervalFromLegacyQuote(
  index: SourceIndex,
  anchor: ReviewHighlightAnchor,
): HighlightInterval | null {
  const quote = anchor.quote.trim();
  if (!quote) return null;
  const candidateNodes = anchor.stale
    ? index.nodes
    : index.nodes.filter(
        (entry) =>
          blockContainsLine(entry.block, anchor.startLine) ||
          blockContainsLine(entry.block, anchor.endLine),
      );
  const candidateStart = candidateNodes[0]?.start;
  const candidateEnd = candidateNodes.at(-1)?.end;
  if (candidateStart === undefined || candidateEnd === undefined) return null;
  const occurrences = allOccurrences(index.source, quote, candidateStart, candidateEnd);
  const start = occurrences.length === 1 ? occurrences[0] : undefined;
  return start === undefined ? null : { anchor, start, end: start + quote.length };
}

function intervalForAnchor(
  index: SourceIndex,
  anchor: ReviewHighlightAnchor,
): HighlightInterval | null {
  if (anchor.imageId) return null;
  return (
    intervalFromTextAnchor(index, anchor) ??
    (anchor.textAnchor ? null : intervalFromLegacyQuote(index, anchor))
  );
}

function rangeForInterval(index: SourceIndex, interval: HighlightInterval): Range | null {
  const startNode = index.nodes.find(
    (entry) => entry.start <= interval.start && interval.start < entry.end,
  );
  const endNode = index.nodes.find(
    (entry) => entry.start < interval.end && interval.end <= entry.end,
  );
  if (!startNode || !endNode) return null;
  const range = startNode.node.ownerDocument.createRange();
  range.setStart(startNode.node, interval.start - startNode.start);
  range.setEnd(endNode.node, interval.end - endNode.start);
  return range;
}

export function findReviewHighlightBlock(
  root: HTMLElement,
  anchor: ReviewHighlightAnchor,
): HTMLElement | null {
  const index = collectSourceText(root);
  const interval = intervalForAnchor(index, anchor);
  if (!interval) return null;
  return (
    index.nodes.find((entry) => entry.start <= interval.start && interval.start < entry.end)
      ?.block ?? null
  );
}

function renderFallbackHighlights(
  root: HTMLElement,
  index: SourceIndex,
  intervals: readonly HighlightInterval[],
): void {
  for (const entry of index.nodes) {
    const boundaries = new Set([entry.start, entry.end]);
    let intersects = false;
    for (const interval of intervals) {
      if (interval.start < entry.end && interval.end > entry.start) {
        intersects = true;
        boundaries.add(Math.max(entry.start, interval.start));
        boundaries.add(Math.min(entry.end, interval.end));
      }
    }
    if (!intersects) continue;
    const ordered = [...boundaries].sort((left, right) => left - right);
    const fragment = root.ownerDocument.createDocumentFragment();
    for (let position = 0; position < ordered.length - 1; position += 1) {
      const start = ordered[position];
      const end = ordered[position + 1];
      if (start === undefined || end === undefined || end <= start) continue;
      const text = entry.node.data.slice(start - entry.start, end - entry.start);
      const active = intervals.filter((interval) => interval.start < end && interval.end > start);
      if (active.length === 0) {
        fragment.append(text);
        continue;
      }
      const mark = root.ownerDocument.createElement("mark");
      mark.className = "review-highlight";
      mark.dataset["feedbackHighlights"] = active.map((interval) => interval.anchor.id).join(" ");
      mark.classList.toggle(
        "is-stale",
        active.some((interval) => interval.anchor.stale),
      );
      const serials = active.map((interval) => `#${interval.anchor.serial}`);
      mark.title = `${serials.length === 1 ? "Comment" : "Comments"} ${serials.join(", ")}`;
      mark.append(text);
      fragment.append(mark);
    }
    entry.node.replaceWith(fragment);
  }
}

export function renderReviewHighlights(
  root: HTMLElement,
  anchors: readonly ReviewHighlightAnchor[],
): number {
  clearReviewHighlights(root);
  const index = collectSourceText(root);
  const intervals = anchors.flatMap((anchor) => {
    const interval = intervalForAnchor(index, anchor);
    return interval ? [interval] : [];
  });
  const ranges = intervals.flatMap((interval) => {
    const range = rangeForInterval(index, interval);
    return range ? [range] : [];
  });

  const view = root.ownerDocument.defaultView as HighlightWindow | null;
  const registry = view?.CSS?.highlights;
  if (registry && view.Highlight) {
    if (ranges.length > 0) registry.set(HIGHLIGHT_NAME, new view.Highlight(...ranges));
  } else {
    renderFallbackHighlights(root, index, intervals);
  }
  return ranges.length;
}
