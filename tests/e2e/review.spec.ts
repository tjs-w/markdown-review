import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const requestLog = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const externalRequests: string[] = [];
  const browserOrigin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:43117").origin;
  page.on("request", (request) => {
    if (!request.url().startsWith(browserOrigin)) externalRequests.push(request.url());
  });
  requestLog.set(page, externalRequests);
  await page.goto("/");
  await expect(page.locator("#title")).toHaveText("Markdown Review Fixture");
  await expect(page.locator("html")).toHaveAttribute("data-surface", "review");
});

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(100);
  expect(requestLog.get(page) ?? []).toEqual([]);
});

test("preserves native selection, queues feedback, and submits one batch", async ({ page }) => {
  expect(await page.evaluate(() => "openai" in window)).toBe(false);
  const paragraph = page.locator(".review-block p").first();
  await expect(paragraph).toContainText("Select and review");
  await paragraph.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  const selectionAction = page.locator("#selection-action");
  await expect(selectionAction).toBeVisible();
  await expect(page.locator("#review-composer")).toBeHidden();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain(
    "Select and review",
  );
  await page.evaluate(() => {
    document.addEventListener(
      "copy",
      () => {
        (window as Window & { __copiedSelection?: string }).__copiedSelection =
          window.getSelection()?.toString() ?? "";
      },
      { once: true },
    );
  });
  await page.keyboard.press("Control+c");
  expect(
    await page.evaluate(
      () => (window as Window & { __copiedSelection?: string }).__copiedSelection,
    ),
  ).toContain("Select and review");

  await selectionAction.click();
  const feedback = page.locator("#feedback");
  await expect(feedback).toBeFocused();
  await feedback.fill("Clarify this statement while keeping literal \\#1.");
  await feedback.press("Shift+Enter");
  await expect(feedback).toHaveValue(/\n$/);
  await feedback.press("Enter");

  await expect(page.locator(".annotation-badge")).toHaveText("1");
  const submit = page.locator("#send-all");
  await expect(submit).toHaveAccessibleName("Submit 1 queued comments");
  await submit.click();
  await expect(page.locator(".annotation-badge")).toHaveCount(0);
  await expect(submit).toBeHidden();
  const messages = await page.evaluate(() => {
    const host = (
      window as Window & {
        __markdownReviewHost?: { messages: unknown[] };
      }
    ).__markdownReviewHost;
    return host?.messages ?? [];
  });
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages)).toContain("markdown-review/v1");
  expect(JSON.stringify(messages)).toContain('"id":"#1"');
});

test("renders the local PNG without network access and passes axe", async ({ page }) => {
  await expect(page.locator("canvas.local-image-canvas")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  const paragraph = page.locator(".review-block p").first();
  await paragraph.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.locator("#selection-action").click();
  await page.locator("#composer-help-toggle").click();
  const composerResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(composerResults.violations).toEqual([]);
  await page.locator("#composer-help-toggle").click();
  const feedback = page.locator("#feedback");
  await feedback.fill("Queued from accessibility journey");
  await feedback.press("Enter");
  await page.locator("#comments-toggle").click();
  const drawerResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(drawerResults.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await page.locator("#theme-toggle").click();
  const darkResults = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(darkResults.violations).toEqual([]);
});

test("does not queue feedback while an IME composition is active", async ({ page }) => {
  const paragraph = page.locator(".review-block p").first();
  await paragraph.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.locator("#selection-action").click();
  const feedback = page.locator("#feedback");
  await feedback.fill("入力中");
  await feedback.dispatchEvent("compositionstart");
  await feedback.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(page.locator("#review-composer")).toBeVisible();
  await expect(page.locator(".annotation-badge")).toHaveCount(0);
  await feedback.dispatchEvent("compositionend");
  await feedback.press("Enter");
  await expect(page.locator(".annotation-badge")).toHaveText("1");
});

test("supports a keyboard-only queue, dialog, and submit journey", async ({ page }) => {
  const paragraph = page.locator(".review-block p").first();
  await paragraph.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const addFeedback = page.locator("#selection-action");
  await addFeedback.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.type("Keyboard review feedback");
  await page.keyboard.press("Enter");
  const commentsToggle = page.locator("#comments-toggle");
  await commentsToggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#close-comments")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator('[data-comment-action="go"]')).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(commentsToggle).toBeFocused();
  const submit = page.locator("#send-all");
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(submit).toBeHidden();
});

test("supports the coarse-pointer review controls", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Touch journey runs in the blocking mobile Chromium project");
  const paragraph = page.locator(".review-block p").first();
  await paragraph.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.locator("#selection-action").tap();
  await page.locator("#feedback").fill("Touch review feedback");
  await page.locator("#add-queue").tap();
  await expect(page.locator(".annotation-badge")).toHaveText("1");
  await page.locator("#comments-toggle").tap();
  await expect(page.locator("#comments-panel")).toBeVisible();
});

test("isolates the optional Codex widget-state compatibility adapter", async ({ page }) => {
  await page.goto("/?codex=1");
  await expect(page.locator("#title")).toHaveText("Markdown Review Fixture");
  expect(await page.evaluate(() => "openai" in window)).toBe(true);
});

test("reflows at 400 percent and honors accessibility media", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = "4";
  });
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await expect(page.locator("#title")).toBeVisible();
  const horizontalOverflow = await page.evaluate(() =>
    [document.documentElement, ...document.querySelectorAll<HTMLElement>(".workspace")].some(
      (element) => element.scrollWidth > element.clientWidth + 1,
    ),
  );
  expect(horizontalOverflow).toBe(false);
});
