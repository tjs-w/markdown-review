import { expect, test, type Locator, type Page } from "@playwright/test";

const requestLog = new WeakMap<Page, string[]>();

async function dragSelect(locator: Locator, page: Page): Promise<string> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected selectable text geometry");
  const y = box.y + Math.min(box.height / 2, 12);
  const left = box.x + 2;
  const right = box.x + Math.min(box.width - 2, 500);
  await page.mouse.move(left, y);
  await page.mouse.down();
  await page.mouse.move(right, y, { steps: 8 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function openAndCancelComposer(page: Page, method: "button" | "escape"): Promise<void> {
  await page.locator("#selection-action").click();
  await expect(page.locator("#review-composer")).toBeVisible();
  if (method === "escape") await page.keyboard.press("Escape");
  else await page.locator("#close-composer").click();
  await expect(page.locator("#review-composer")).toBeHidden();
}

async function clickAwayFromSelection(page: Page): Promise<void> {
  await page.locator(".review-block h1").first().click();
}

async function openKeyboardContextMenu(page: Page, target: Locator): Promise<void> {
  await target.evaluate((element) => {
    element.setAttribute("tabindex", "-1");
    (element as HTMLElement).focus();
  });
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#review-context-menu")).toBeVisible();
}

async function selectAcrossNodes(page: Page, startSelector: string, endSelector: string) {
  return page.evaluate(
    ({ startSelector: start, endSelector: end }) => {
      const startText = document.querySelector(start)?.firstChild;
      const endText = document.querySelector(end)?.firstChild;
      if (!(startText instanceof Text) || !(endText instanceof Text)) {
        throw new Error("Expected text selection boundaries");
      }
      const range = document.createRange();
      range.setStart(startText, 0);
      range.setEnd(endText, endText.data.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return selection?.toString() ?? "";
    },
    { startSelector, endSelector },
  );
}

test.beforeEach(async ({ page }) => {
  const externalRequests: string[] = [];
  const browserOrigin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:43117").origin;
  page.on("request", (request) => {
    if (!request.url().startsWith(browserOrigin)) externalRequests.push(request.url());
  });
  requestLog.set(page, externalRequests);
  await page.goto("/");
  await expect(page.locator("#title")).toHaveText("Markdown Review Fixture");
  await expect(page.locator(".mermaid-render svg")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(100);
  expect(requestLog.get(page) ?? []).toEqual([]);
});

for (const method of ["escape", "button"] as const) {
  test(`reselects the identical passage after cancelling with ${method}`, async ({ page }) => {
    const paragraph = page.locator(".review-block p").first();
    const firstSelection = await dragSelect(paragraph, page);
    expect(firstSelection).toContain("Select and review this paragraph");
    await expect(page.locator("#selection-action")).toBeVisible();
    await openAndCancelComposer(page, method);
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);

    const secondSelection = await dragSelect(paragraph, page);
    expect(secondSelection).toContain("Select and review this paragraph");
    await expect(page.locator("#selection-action")).toBeVisible();
  });
}

test("reselects after clearing a selection by clicking elsewhere", async ({ page }) => {
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  await expect(page.locator("#selection-action")).toBeVisible();
  await clickAwayFromSelection(page);
  await expect(page.locator("#selection-action")).toBeHidden({ timeout: 1_000 });

  const selection = await dragSelect(paragraph, page);
  expect(selection).toContain("Select and review this paragraph");
  await expect(page.locator("#selection-action")).toBeVisible({ timeout: 1_000 });
});

test("Escape dismisses a pending selection and permits identical reselection", async ({ page }) => {
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  const action = page.locator("#selection-action");
  const status = page.locator("#selection-status");
  await expect(action).toBeVisible();
  await expect(action).toHaveAccessibleName("Add feedback for selection, Line 3");
  await expect(status).toContainText("Selection ready for feedback, Line 3");
  await page.keyboard.press("Escape");
  await expect(action).toBeHidden({ timeout: 1_000 });
  await expect(page.locator("#review-composer")).toBeHidden();
  await expect(status).toHaveText("Selection cleared.");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);

  const selection = await dragSelect(paragraph, page);
  expect(selection).toContain("Select and review this paragraph");
  await expect(action).toBeVisible({ timeout: 1_000 });
  await expect(status).toContainText("Selection ready for feedback, Line 3");
});

test("opens feedback when the host collapses selection during plus-button activation", async ({
  page,
}) => {
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  const action = page.locator("#selection-action");
  await expect(action).toBeVisible();
  await action.evaluate((element) => {
    element.addEventListener(
      "pointerdown",
      () => {
        window.getSelection()?.removeAllRanges();
        document.dispatchEvent(new Event("selectionchange"));
      },
      { once: true },
    );
  });
  await action.click();
  await expect(page.locator("#review-composer")).toBeVisible();
  await expect(page.locator("#quote")).toHaveText("Select and review this paragraph.");
});

test("reselects highlighted text after queueing a comment", async ({ page }) => {
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  await page.locator("#selection-action").click();
  await page.locator("#feedback").fill("First comment on this passage");
  await page.locator("#feedback").press("Enter");
  await expect(page.locator(".annotation-badge")).toHaveText("1");

  const selection = await dragSelect(paragraph, page);
  expect(selection).toContain("Select and review this paragraph");
  await expect(page.locator("#selection-action")).toBeVisible();
  await page.locator("#selection-action").click();
  await expect(page.locator("#review-composer")).toBeVisible();
});

test("reselects after dismissing the selection context menu", async ({ page }) => {
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  await paragraph.click({ button: "right" });
  await expect(page.locator("#review-context-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#review-context-menu")).toBeHidden();

  await clickAwayFromSelection(page);
  const selection = await dragSelect(paragraph, page);
  expect(selection).toContain("Select and review this paragraph");
  await expect(page.locator("#selection-action")).toBeVisible();
});

test("selects across queued comment UI without including the inserted controls", async ({
  page,
}) => {
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  await page.locator("#selection-action").click();
  await page.locator("#feedback").fill("An inserted comment between source blocks");
  await page.locator("#feedback").press("Enter");
  await expect(page.locator(".queued-card")).toBeVisible();

  const selection = await selectAcrossNodes(page, ".review-block h1", ".review-block h2");
  expect(selection).toContain("An inserted comment between source blocks");
  await expect(page.locator("#selection-action")).toBeVisible({ timeout: 1_000 });
  await page.locator("#selection-action").click();
  await expect(page.locator("#line-pill")).toHaveText("Lines 1–5");
  await expect(page.locator("#quote")).toHaveText(
    "Markdown Review Fixture\nSelect and review this paragraph.\nImages",
  );
  await expect(page.locator("#quote")).not.toContainText(
    "An inserted comment between source blocks",
  );
  await page.locator("#close-composer").click();

  const uiOnlySelection = await page.locator(".queued-card .card-feedback").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const nativeSelection = window.getSelection();
    nativeSelection?.removeAllRanges();
    nativeSelection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return nativeSelection?.toString() ?? "";
  });
  expect(uiOnlySelection).toBe("An inserted comment between source blocks");
  await expect(page.locator("#selection-action")).toBeHidden({ timeout: 1_000 });

  const sourceToUiSelection = await selectAcrossNodes(
    page,
    ".review-block h1",
    ".queued-card .card-feedback",
  );
  expect(sourceToUiSelection).toContain("Markdown Review Fixture");
  expect(sourceToUiSelection).toContain("An inserted comment between source blocks");
  await expect(page.locator("#selection-action")).toBeHidden({ timeout: 1_000 });

  await selectAcrossNodes(page, ".review-block h1", ".review-block h2");
  await expect(page.locator("#selection-action")).toBeVisible();
  await page.locator(".queued-card .card-feedback").click({ button: "right" });
  await expect(page.locator("#review-context-menu")).toBeVisible();
  await expect(page.locator("#context-copy-selection")).toBeHidden();
  await expect(page.locator("#context-comment-selection")).toBeHidden();
  await expect(page.locator("#context-comment-document")).toBeFocused();
});

test("does not offer stale selection actions when right-clicking outside the selection", async ({
  page,
}) => {
  await page.evaluate(() => {
    const block = document.createElement("section");
    block.className = "review-block";
    block.dataset["startLine"] = "19";
    block.dataset["endLine"] = "19";
    const paragraph = document.createElement("p");
    paragraph.innerHTML =
      '<span id="stress-selected-words">Selected words</span> <span id="stress-unselected-words">unselected words</span>';
    block.appendChild(paragraph);
    document.getElementById("document")?.appendChild(block);
  });
  await page.locator("#stress-selected-words").scrollIntoViewIfNeeded();

  await page.locator("#stress-selected-words").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.locator("#selection-action")).toBeVisible();
  await page.locator("#stress-selected-words").click({ button: "right" });
  await expect(page.locator("#review-context-menu")).toBeVisible();
  await expect(page.locator("#context-copy-selection")).toBeVisible();
  await expect(page.locator("#context-comment-selection")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator("#stress-selected-words").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.locator("#stress-unselected-words").click({ button: "right" });
  await expect(page.locator("#review-context-menu")).toBeVisible();
  await expect(page.locator("#context-copy-selection")).toBeHidden({ timeout: 1_000 });
  await expect(page.locator("#context-comment-selection")).toBeHidden();
  await expect(page.locator("#context-comment-document")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.locator("#stress-selected-words").evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const keyboardMenuTarget = page.locator(".review-block h2", { hasText: "Mermaid" });
  await keyboardMenuTarget.scrollIntoViewIfNeeded();
  await keyboardMenuTarget.evaluate((element) => {
    element.setAttribute("tabindex", "-1");
    (element as HTMLElement).focus({ preventScroll: true });
  });
  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#review-context-menu")).toBeVisible();
  await expect(page.locator("#context-copy-selection")).toBeHidden();
  await expect(page.locator("#context-comment-selection")).toBeHidden();
  await expect(page.locator("#context-comment-document")).toBeFocused();
});

test("drag-selecting a link does not activate external navigation", async ({ page }) => {
  await page.evaluate(() => {
    const block = document.createElement("section");
    block.className = "review-block";
    block.dataset["startLine"] = "20";
    block.dataset["endLine"] = "20";
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.dataset["reviewHref"] = "https://example.com/selected-link";
    link.setAttribute("role", "link");
    link.tabIndex = 0;
    link.textContent = "Drag across this external link without opening it";
    paragraph.appendChild(link);
    block.appendChild(paragraph);
    document.getElementById("document")?.appendChild(block);
  });
  const link = page.locator("a[data-review-href]").last();

  await link.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __markdownReviewHost?: { externalLinks: string[] };
            }
          ).__markdownReviewHost?.externalLinks ?? [],
      ),
    )
    .toEqual(["https://example.com/selected-link"]);
  await link.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __markdownReviewHost?: { externalLinks: string[] };
            }
          ).__markdownReviewHost?.externalLinks ?? [],
      ),
    )
    .toEqual(["https://example.com/selected-link", "https://example.com/selected-link"]);

  const selection = await dragSelect(link, page);
  expect(selection).toContain("Drag across this external link");
  await expect(page.locator("#selection-action")).toBeVisible();
  await page.waitForTimeout(150);
  const afterForwardDrag = await page.evaluate(
    () =>
      (
        window as Window & {
          __markdownReviewHost?: { externalLinks: string[] };
        }
      ).__markdownReviewHost?.externalLinks ?? [],
  );
  expect(afterForwardDrag).toEqual([
    "https://example.com/selected-link",
    "https://example.com/selected-link",
  ]);

  await clickAwayFromSelection(page);
  await link.scrollIntoViewIfNeeded();
  const backwardSelection = await link.evaluate((element) => {
    const text = element.firstChild;
    if (!(text instanceof Text)) throw new Error("Expected reverse link-selection text");
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.setBaseAndExtent(text, text.data.length, text, 0);
    document.dispatchEvent(new Event("selectionchange"));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    return selection?.toString() ?? "";
  });
  expect(backwardSelection).toContain("Drag across this external link");
  await expect(page.locator("#selection-action")).toBeVisible();
  await page.waitForTimeout(150);
  expect(
    await page.evaluate(
      () =>
        (
          window as Window & {
            __markdownReviewHost?: { externalLinks: string[] };
          }
        ).__markdownReviewHost?.externalLinks ?? [],
    ),
  ).toEqual(["https://example.com/selected-link", "https://example.com/selected-link"]);

  expect(page.url()).toBe(new URL("/", test.info().project.use.baseURL).href);
});

test("does not silently discard a draft opened while refresh is in flight", async ({ page }) => {
  const initialRevision = (await page.locator("#meta").textContent())?.match(/rev (\S+)$/u)?.[1];
  expect(initialRevision).toBeTruthy();
  await page.route("**/call", async (route) => {
    const request = route.request();
    const input = JSON.parse(request.postData() ?? "{}") as { name?: string };
    if (input.name !== "load_markdown_review_document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const result = (await response.json()) as {
      _meta: { document: { revision: string } };
      structuredContent: { revision: string };
    };
    result._meta.document.revision = "stress-refresh-revision";
    result.structuredContent.revision = "stress-refresh-revision";
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.fulfill({ response, json: result });
  });

  await page.locator("#refresh").click();
  await expect(page.locator("#document")).toHaveAttribute("aria-busy", "true");
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  await expect(page.locator("#selection-action")).toBeVisible();
  await page.locator("#selection-action").click();
  await page.locator("#feedback").fill("Do not lose this in-flight draft");

  await expect(page.locator("#meta")).toContainText("stress-refresh-revision");
  await expect(page.locator("#review-composer")).toBeVisible({ timeout: 1_000 });
  await expect(page.locator("#feedback")).toHaveValue("Do not lose this in-flight draft");
  await expect(page.locator("#feedback")).toBeFocused();
  await page.locator("#feedback").press("Enter");
  await expect(page.locator(".queued-card")).toContainText("Do not lose this in-flight draft");
  await expect(page.locator(".queued-card .status-chip.warning")).toHaveText("Source changed");
  await expect
    .poll(() =>
      page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key?.startsWith("markdown-review:state:v1:")) continue;
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const stored = JSON.parse(raw) as {
            state?: { queue?: { feedback?: string; revision?: string }[] };
          };
          const draft = stored.state?.queue?.find(
            (item) => item.feedback === "Do not lose this in-flight draft",
          );
          if (draft) return draft.revision ?? null;
        }
        return null;
      }),
    )
    .toBe(initialRevision);
});

for (const primaryClipboard of ["denied", "missing"] as const) {
  test(`copies through the fallback when the Clipboard API is ${primaryClipboard}`, async ({
    page,
  }) => {
    await page.evaluate((primary) => {
      const writes: string[] = [];
      Object.assign(window, { __stressFallbackClipboardWrites: writes });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value:
          primary === "missing"
            ? undefined
            : {
                writeText: () =>
                  Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
              },
      });
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value(command: string) {
          if (command !== "copy") return false;
          const clipboardValues = new Map<string, string>();
          const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
          Object.defineProperty(copyEvent, "clipboardData", {
            value: {
              clearData: () => {
                clipboardValues.clear();
              },
              getData: (type: string) => clipboardValues.get(type) ?? "",
              setData: (type: string, value: string) => {
                clipboardValues.set(type, value);
              },
            },
          });
          document.dispatchEvent(copyEvent);
          const active = document.activeElement;
          const fallbackText =
            active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement
              ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
              : (window.getSelection()?.toString() ?? "");
          writes.push(clipboardValues.get("text/plain") ?? fallbackText);
          return true;
        },
      });
    }, primaryClipboard);

    const paragraph = page.locator(".review-block p").first();
    const selected = await dragSelect(paragraph, page);
    expect(selected).toContain("Select and review this paragraph");
    await openKeyboardContextMenu(page, paragraph);
    await page.locator("#context-copy-selection").click();
    await expect(page.locator("#toast-message")).toHaveText("Selected text copied.");
    await expect(page.locator("#toast-message")).not.toContainText("permission");
    expect(
      await page.evaluate(
        () =>
          (
            window as Window & {
              __stressFallbackClipboardWrites?: string[];
            }
          ).__stressFallbackClipboardWrites ?? [],
      ),
    ).toEqual(["Select and review this paragraph."]);
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""))
      .toBe("Select and review this paragraph.");
    await page.keyboard.press("Escape");
    const reselected = await dragSelect(paragraph, page);
    expect(reselected).toContain("Select and review this paragraph");
    await expect(page.locator("#selection-action")).toBeVisible();
  });
}

test("offers a keyboard-copy fallback when every clipboard mechanism is unavailable", async ({
  page,
}) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => Promise.reject(new DOMException("secret denial", "NotAllowedError")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
  });
  const paragraph = page.locator(".review-block p").first();
  await dragSelect(paragraph, page);
  await openKeyboardContextMenu(page, paragraph);
  await page.locator("#context-copy-selection").click();
  const dialog = page.getByRole("dialog", { name: "Copy selected text" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Clipboard permission is blocked. Press Command+C or Control+C to copy the selected text.",
  );
  const manualField = page.getByRole("textbox", { name: "Selected Markdown text" });
  await expect(manualField).toBeFocused();
  await expect(manualField).toHaveValue("Select and review this paragraph.");
  expect(
    await manualField.evaluate((field) => ({
      start: (field as HTMLTextAreaElement).selectionStart,
      end: (field as HTMLTextAreaElement).selectionEnd,
    })),
  ).toEqual({ start: 0, end: "Select and review this paragraph.".length });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await page.locator("body").innerText()).not.toContain("secret denial");
  expect(await page.evaluate(() => document.querySelectorAll(".manual-copy-dialog").length)).toBe(
    0,
  );
});

test("survives twenty identical select-cancel cycles", async ({ page }) => {
  const paragraph = page.locator(".review-block p").first();
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const selection = await dragSelect(paragraph, page);
    expect(selection, `selection in cycle ${String(iteration + 1)}`).toContain(
      "Select and review this paragraph",
    );
    await expect(page.locator("#selection-action")).toBeVisible();
    if (iteration % 2 === 0) {
      await page.keyboard.press("Escape");
      await expect(page.locator("#selection-action")).toBeHidden();
    } else {
      await openAndCancelComposer(page, "escape");
    }
    await expect.poll(() => page.evaluate(() => window.getSelection()?.isCollapsed)).toBe(true);
  }
});
