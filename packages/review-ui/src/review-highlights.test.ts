import { afterEach, describe, expect, test } from "bun:test";

import {
  captureReviewTextAnchor,
  findReviewHighlightBlock,
  renderReviewHighlights,
} from "./review-highlights";

afterEach(() => {
  document.body.replaceChildren();
});

function installDocument(): HTMLElement {
  document.body.innerHTML =
    '<article id="document">' +
    '<section class="review-block" data-start-line="1" data-end-line="2"><p>Alpha <em>beta</em> gamma beta.</p></section>' +
    '<section class="review-block" data-start-line="3" data-end-line="4"><p>Delta <code>epsilon</code>.</p></section>' +
    '<section class="review-block" data-start-line="5" data-end-line="5"><span class="local-image">Loading image…</span><p>Omega.</p></section>' +
    "</article>";
  const root = document.getElementById("document");
  if (!root) throw new Error("Expected document fixture");
  return root;
}

function rangeForText(text: Text, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  return range;
}

describe("review text highlights", () => {
  test("captures and restores the exact repeated selection with bounded context", () => {
    const root = installDocument();
    const paragraph = root.querySelector("p");
    const finalText = paragraph?.lastChild;
    if (!(finalText instanceof Text)) throw new Error("Expected final text node");
    const captured = captureReviewTextAnchor(root, rangeForText(finalText, 7, 11));
    expect(captured?.quote).toBe("beta");
    expect(captured?.textAnchor.prefix.endsWith("gamma ")).toBeTrue();

    expect(
      renderReviewHighlights(root, [
        {
          id: "feedback-1",
          serial: 1,
          startLine: 1,
          endLine: 2,
          quote: captured?.quote ?? "",
          textAnchor: captured?.textAnchor,
        },
      ]),
    ).toBe(1);
    expect([...root.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["beta"]);
    expect(root.textContent).toBe("Alpha beta gamma beta.Delta epsilon.Loading image…Omega.");
  });

  test("captures element-boundary selections without losing duplicate-text identity", () => {
    const root = installDocument();
    const emphasis = root.querySelector("em");
    if (!emphasis) throw new Error("Expected emphasis fixture");
    const range = document.createRange();
    range.selectNodeContents(emphasis);
    const captured = captureReviewTextAnchor(root, range);
    expect(captured?.quote).toBe("beta");

    expect(
      renderReviewHighlights(root, [
        {
          id: "feedback-1",
          serial: 1,
          startLine: 1,
          endLine: 2,
          quote: captured?.quote ?? "",
          textAnchor: captured?.textAnchor,
        },
      ]),
    ).toBe(1);
    expect(root.querySelector("em mark.review-highlight")?.textContent).toBe("beta");
    expect(root.querySelector("p")?.lastChild?.textContent).toContain("beta");
  });

  test("anchors a selection after a heading to the first text it actually contains", () => {
    const root = installDocument();
    const headingTail = root.querySelector("p")?.lastChild;
    const followingText = root.querySelectorAll("p")[1]?.firstChild;
    if (!(headingTail instanceof Text) || !(followingText instanceof Text)) {
      throw new Error("Expected adjacent text blocks");
    }
    const range = document.createRange();
    range.setStart(headingTail, headingTail.data.length);
    range.setEnd(followingText, 5);

    const captured = captureReviewTextAnchor(root, range);
    expect(captured?.quote).toBe("Delta");
    expect(captured?.startBlock.dataset["startLine"]).toBe("3");
    expect(captured?.endBlock.dataset["endLine"]).toBe("4");
  });

  test("captures selections across formatting and blocks with UTF-16 offsets", () => {
    const root = installDocument();
    const beta = root.querySelector("em")?.firstChild;
    const epsilon = root.querySelector("code")?.firstChild;
    if (!(beta instanceof Text) || !(epsilon instanceof Text)) throw new Error("Expected text");
    beta.data = "βeta 😀";
    const range = document.createRange();
    range.setStart(beta, 0);
    range.setEnd(epsilon, epsilon.data.length);
    const captured = captureReviewTextAnchor(root, range);
    expect(captured?.quote).toContain("βeta 😀 gamma beta.\nDelta epsilon");
    expect(captured?.textAnchor.end).toBeGreaterThan(captured?.textAnchor.start ?? 0);
    expect(
      renderReviewHighlights(root, [
        {
          id: "feedback-1",
          serial: 1,
          startLine: 1,
          endLine: 4,
          quote: captured?.quote ?? "",
          textAnchor: captured?.textAnchor,
        },
      ]),
    ).toBe(1);
    expect(root.querySelectorAll("mark.review-highlight").length).toBeGreaterThan(1);
  });

  test("keeps native highlight ranges out of review UI inserted between selected blocks", () => {
    const root = installDocument();
    const firstText = root.querySelector("em")?.firstChild;
    const finalText = root.querySelectorAll("p")[1]?.firstChild;
    if (!(firstText instanceof Text) || !(finalText instanceof Text)) {
      throw new Error("Expected cross-block text");
    }
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.setEnd(finalText, 5);
    const captured = captureReviewTextAnchor(root, range);
    if (!captured) throw new Error("Expected captured anchor");

    const comment = document.createElement("aside");
    comment.dataset["reviewUi"] = "queued-comment";
    comment.textContent = "Comment quote must remain unhighlighted";
    root.querySelector(".review-block")?.insertAdjacentElement("afterend", comment);

    const originalCss = Object.getOwnPropertyDescriptor(window, "CSS");
    const originalHighlight = Object.getOwnPropertyDescriptor(window, "Highlight");
    let registeredRanges: Range[] = [];
    const TestHighlight = function (...ranges: Range[]): void {
      registeredRanges = ranges;
    };
    Object.defineProperty(window, "CSS", {
      configurable: true,
      value: { highlights: { set: () => undefined, delete: () => true } },
    });
    Object.defineProperty(window, "Highlight", { configurable: true, value: TestHighlight });
    try {
      expect(
        renderReviewHighlights(root, [
          {
            id: "feedback-1",
            serial: 1,
            startLine: 1,
            endLine: 4,
            quote: captured.quote,
            textAnchor: captured.textAnchor,
          },
        ]),
      ).toBe(1);
      expect(registeredRanges).toHaveLength(2);
      expect(registeredRanges.map((registered) => registered.toString()).join(" ")).not.toContain(
        "Comment quote",
      );
    } finally {
      if (originalCss) Object.defineProperty(window, "CSS", originalCss);
      else delete (window as Window & { CSS?: unknown }).CSS;
      if (originalHighlight) Object.defineProperty(window, "Highlight", originalHighlight);
      else delete (window as Window & { Highlight?: unknown }).Highlight;
    }
  });

  test("segments overlapping comments without nesting fallback marks", () => {
    const root = installDocument();
    const first = root.querySelector("p")?.firstChild;
    const beta = root.querySelector("em")?.firstChild;
    const tail = root.querySelector("p")?.lastChild;
    if (!(first instanceof Text) || !(beta instanceof Text) || !(tail instanceof Text)) {
      throw new Error("Expected text fixture");
    }
    const leftRange = document.createRange();
    leftRange.setStart(beta, 0);
    leftRange.setEnd(tail, 6);
    const rightRange = document.createRange();
    rightRange.setStart(tail, 1);
    rightRange.setEnd(tail, 11);
    const left = captureReviewTextAnchor(root, leftRange);
    const right = captureReviewTextAnchor(root, rightRange);
    renderReviewHighlights(root, [
      {
        id: "feedback-1",
        serial: 1,
        startLine: 1,
        endLine: 2,
        quote: left?.quote ?? "",
        textAnchor: left?.textAnchor,
      },
      {
        id: "feedback-2",
        serial: 2,
        startLine: 1,
        endLine: 2,
        quote: right?.quote ?? "",
        textAnchor: right?.textAnchor,
      },
    ]);
    const marks = [...root.querySelectorAll<HTMLElement>("mark")];
    expect(marks.some((mark) => mark.dataset["feedbackHighlights"]?.includes("feedback-1"))).toBe(
      true,
    );
    expect(marks.some((mark) => mark.dataset["feedbackHighlights"]?.includes("feedback-2"))).toBe(
      true,
    );
    expect(marks.some((mark) => mark.dataset["feedbackHighlights"]?.includes(" "))).toBe(true);
    expect(root.querySelector("mark mark")).toBeNull();
    expect(first.data).toBe("Alpha ");
  });

  test("relocates a unique stale anchor and fails closed for ambiguous or changed selections", () => {
    const root = installDocument();
    const epsilon = root.querySelector("code")?.firstChild;
    if (!(epsilon instanceof Text)) throw new Error("Expected text fixture");
    const captured = captureReviewTextAnchor(root, rangeForText(epsilon, 0, epsilon.data.length));
    if (!captured) throw new Error("Expected captured anchor");
    epsilon.data = "changed";
    const omega = root.querySelectorAll("p")[2];
    omega?.prepend("epsilon ");
    const stale = {
      id: "feedback-1",
      serial: 1,
      startLine: 1,
      endLine: 2,
      quote: captured.quote,
      textAnchor: captured.textAnchor,
      stale: true,
    };
    expect(renderReviewHighlights(root, [stale])).toBe(1);
    expect(findReviewHighlightBlock(root, stale)?.dataset["startLine"]).toBe("5");

    root.querySelectorAll("p")[1]?.append(" epsilon");
    expect(renderReviewHighlights(root, [stale])).toBe(0);
    expect(root.querySelector("mark")).toBeNull();

    expect(renderReviewHighlights(root, [{ ...stale, stale: false }])).toBe(0);
  });

  test("supports unambiguous legacy comments and excludes local-image status text", () => {
    const root = installDocument();
    expect(
      renderReviewHighlights(root, [
        { id: "feedback-1", serial: 1, startLine: 3, endLine: 4, quote: "Delta" },
      ]),
    ).toBe(1);
    expect(root.querySelector("mark")?.textContent).toBe("Delta");
    expect(
      renderReviewHighlights(root, [
        { id: "feedback-2", serial: 2, startLine: 1, endLine: 2, quote: "beta" },
      ]),
    ).toBe(0);
    expect(
      renderReviewHighlights(root, [
        {
          id: "feedback-3",
          serial: 3,
          startLine: 5,
          endLine: 5,
          quote: "Loading image…",
        },
      ]),
    ).toBe(0);
  });
});
