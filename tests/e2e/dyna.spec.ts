import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/dyna");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
});

test("renders the fixed executive catalog without external requests", async ({ page }) => {
  const externalRequests: string[] = [];
  const origin = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:43117").origin;
  page.on("request", (request) => {
    if (!request.url().startsWith(origin)) externalRequests.push(request.url());
  });

  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.getByText("Critical", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review in Codex" })).toBeVisible();
  await expect(page.getByText("Browser fixture schedule", { exact: true })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "fullscreen");
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute(
    "data-dyna-advertised-display-modes",
    '["inline","fullscreen"]',
  );
  await expect(page.locator("html")).toHaveAttribute("data-platform", "mobile");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--d-safe-top"),
    ),
  ).toBe("8px");
  expect(externalRequests).toEqual([]);

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("adds an annotation and sends only an opaque Codex action request", async ({ page }) => {
  const addNote = page.getByRole("button", { name: "Add note" });
  await addNote.focus();
  await addNote.click();
  const note = page.getByPlaceholder("Example: Create a new Codex task to review this MR");
  await expect(page.getByRole("textbox", { name: "Note" })).toBeFocused();
  const modalAccessibility = await new AxeBuilder({ page }).analyze();
  expect(modalAccessibility.violations).toEqual([]);
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(addNote).toBeFocused();
  await addNote.click();
  await note.fill("Create a new Codex task to review this MR.");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(addNote).toBeFocused();
  await expect(
    page.locator(".dyna-note-list li").filter({ hasText: "Create a new Codex task" }).first(),
  ).toBeVisible();

  await page.getByRole("button", { name: "Review in Codex" }).click();
  await expect.poll(() => page.locator("html").getAttribute("data-dyna-message-count")).toBe("1");
  const message = await page.locator("html").getAttribute("data-dyna-last-message");
  expect(message).toMatch(/Handle Dyna action request [0-9a-f-]{36} with \$flowzone:dyna\./);
  expect(message).not.toContain("release merge request");
  expect(message).not.toContain("Create a new Codex task");
});

test("reflows at 320 CSS pixels without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  for (const button of await page.getByRole("button").all()) {
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});

test("requests the expanded Codex work surface when the host supports it", async ({ page }) => {
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "fullscreen");
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-dyna-display-mode-request-count", "1");
});

test("does not expose a duplicate expand action while initial negotiation is pending", async ({
  page,
}) => {
  await page.goto("/dyna?display-mode-delay=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  expect(await page.locator(".dyna").getAttribute("data-display-mode")).toBe("inline");
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeHidden();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "fullscreen");
  await expect(page.locator("html")).toHaveAttribute("data-dyna-display-mode-request-count", "1");
});

test("keeps inline content visible when the host cannot expand", async ({ page }) => {
  await page.goto("/dyna?inline-only=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.getByText("Review the release merge request")).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeHidden();
  await expect(page.locator(".dyna-inline-more")).toHaveCount(0);
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator("html")).not.toHaveAttribute("data-dyna-display-mode-request-count");
});

test("keeps a complete manual fallback when an expanded presentation request fails", async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  await page.goto("/dyna?display-mode-error=1&many-items=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator(".dyna-card")).toHaveCount(4);
  await expect(page.locator(".dyna-inline-more")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Expand dashboard" }).click();
  await expect(page.getByRole("status")).toContainText("complete inline view remains available");
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand dashboard" })).toBeFocused();
  expect(pageErrors).toEqual([]);
});

test("keeps a complete manual fallback when the host resolves expansion as inline", async ({
  page,
}) => {
  await page.goto("/dyna?display-mode-result=inline&many-items=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await expect(page.locator(".dyna")).toHaveAttribute("data-display-mode", "inline");
  await expect(page.locator(".dyna-card")).toHaveCount(4);
  const expand = page.getByRole("button", { name: "Expand dashboard" });
  await expand.click();
  await expect(page.getByRole("status")).toContainText("complete inline view remains available");
  await expect(expand).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-dyna-display-mode-request-count", "2");
});

test("retries an uncertain delivery with the same idempotent request", async ({ page }) => {
  await page.goto("/dyna?action-error=1");
  await expect(page.getByRole("heading", { name: "Executive brief" })).toBeVisible();
  await page.getByRole("button", { name: "Review in Codex" }).click();
  await expect(page.getByRole("alert")).toContainText("delivery is uncertain");
  const messages = await page.evaluate(() => {
    const host = (window as typeof window & { __dynaHost?: { messages?: unknown[] } }).__dynaHost;
    return host?.messages?.map((message) => JSON.stringify(message)) ?? [];
  });
  expect(messages).toHaveLength(2);
  expect(messages[0]).toBe(messages[1]);
});
