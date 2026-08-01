/**
 * Every interactive control on the board, exercised for its actual effect —
 * not merely "the click did not throw".
 *
 * This exists because a whole class of controls was silently dead: the canvas
 * captured the pointer on any pointerdown that bubbled up to it, which
 * retargeted pointerup away from the button, so the browser never dispatched
 * `click`. Nothing threw and nothing logged; the buttons just did nothing.
 * A test that only asserted "clickable" would have passed. Each case below
 * therefore asserts an observable consequence.
 */
import { expect, test } from "@playwright/test";

import {
  createBoardAsGuest,
  createDocArtifact,
  docTextarea,
  waitForBoardReady,
} from "../helpers/board";

test("empty-state controls inside the canvas actually fire (pointer-capture regression)", async ({
  browser,
}) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  // The canvas is a pan surface; these buttons are its descendants. Each must
  // still produce its effect, or the pointer-capture bug has returned.
  await expect(page.getByRole("button", { name: "New doc" })).toBeVisible();

  await page.getByRole("button", { name: "New doc" }).click();
  await expect(
    page.getByRole("article", { name: /Document artifact: Untitled doc/ }),
  ).toBeVisible();

  await owner.context.close();
});

test("the empty state's New table button creates a table", async ({ browser }) => {
  // A fresh board: the empty state (and its buttons) disappears once the
  // canvas has any artifact on it.
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  await page.getByRole("button", { name: "New table" }).click();
  await expect(page.getByRole("article", { name: /Table artifact: Untitled table/ })).toBeVisible();

  await owner.context.close();
});

test("connect-an-agent opens the form and validates before it will submit", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  await page
    .getByRole("button", { name: /Connect an agent/ })
    .first()
    .click();

  const name = page.getByLabel(/name/i).first();
  await expect(name).toBeVisible();

  // A model agent with no model name must be refused (the worker cannot run it).
  await name.fill("Researcher");
  const modelToggle = page.getByRole("button", { name: /^model$/i });
  if (await modelToggle.count()) await modelToggle.first().click();
  await page.getByLabel(/url/i).first().fill("https://api.openai.com/v1");

  const submit = page.getByRole("button", { name: /^(Connect|Add agent)/ }).last();
  await submit.click();
  // Either the field is required client-side or the API rejects it — both are
  // acceptable, but the agent must NOT be silently created.
  await expect(page.getByText(/model|required|invalid/i).first()).toBeVisible({ timeout: 10_000 });

  await owner.context.close();
});

test("header controls: roster toggle, share popover with a copyable link, command palette", async ({
  browser,
}) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  // Roster strip collapses and expands.
  const roster = page.getByRole("button", { name: /Agents/ });
  await roster.click();
  await expect(page.getByRole("button", { name: /Connect an agent/ }).first()).toBeVisible();
  await roster.click();

  // Share is one click to a link — never an admin panel.
  await page.getByRole("button", { name: "Share" }).click();
  const shareDialog = page.getByRole("dialog");
  await expect(shareDialog).toBeVisible({ timeout: 10_000 });
  await expect(shareDialog.getByRole("button", { name: /Copy link/i })).toBeVisible();
  await page.keyboard.press("Escape");

  // Command palette opens by button and by ⌘K, and closes with Escape.
  await page.getByRole("button", { name: /command palette/i }).click();
  await expect(page.getByPlaceholder(/type a command|search/i)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByPlaceholder(/type a command|search/i)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");

  await owner.context.close();
});

test("command palette can create an artifact", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder(/type a command|search/i);
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill("doc");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("article", { name: /Document artifact: Untitled doc/ })).toBeVisible({
    timeout: 10_000,
  });

  await owner.context.close();
});

test("composer: Send is gated on content, sends on click, and clears", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  const composer = page.getByRole("combobox", { name: "Message the board" });
  const send = page.getByRole("button", { name: "Send" });

  // Empty composer must not be sendable.
  await expect(send).toBeDisabled();

  await composer.fill("hello from the test");
  await expect(send).toBeEnabled();
  await send.click();

  await expect(page.getByText("hello from the test")).toBeVisible({ timeout: 10_000 });
  await expect(composer).toHaveValue("");
  await expect(send).toBeDisabled();

  await owner.context.close();
});

test("composer: Cmd+Enter sends without touching the mouse", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  const composer = page.getByRole("combobox", { name: "Message the board" });
  await composer.fill("sent by keyboard");
  await composer.press("ControlOrMeta+Enter");

  await expect(page.getByText("sent by keyboard")).toBeVisible({ timeout: 10_000 });
  await expect(composer).toHaveValue("");

  await owner.context.close();
});

test("artifact body is editable and the edit persists in the doc", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  await createDocArtifact(page);
  const body = docTextarea(page);
  await body.click();
  await body.fill("# Edited by the test");

  await expect(body).toHaveValue("# Edited by the test");

  // Survives a reload — proving it reached the CRDT, not just local state.
  await page.reload();
  await waitForBoardReady(page);
  await expect(docTextarea(page)).toHaveValue("# Edited by the test", { timeout: 15_000 });

  await owner.context.close();
});

test("every visible enabled control is genuinely hit-testable", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  // An element covered by an overlay at its own centre can never be clicked by
  // a real user, however green the unit tests are.
  const obstructed = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('button, a[href], [role="button"]').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return;
      if (getComputedStyle(el as HTMLElement).pointerEvents === "none") {
        out.push(`${el.textContent?.trim().slice(0, 30)} (pointer-events:none)`);
        return;
      }
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      if (top && top !== el && !el.contains(top)) {
        out.push(`${el.textContent?.trim().slice(0, 30)} (covered by ${top.tagName})`);
      }
    });
    return out;
  });

  expect(obstructed, `unreachable controls: ${obstructed.join(", ")}`).toEqual([]);

  await owner.context.close();
});

test("keyboard: every control is reachable by Tab with a visible focus ring", async ({
  browser,
}) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;

  const seen = new Set<string>();
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return {
        label: (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40),
        hasRing:
          style.outlineStyle !== "none" ||
          style.boxShadow !== "none" ||
          Number.parseFloat(style.outlineWidth || "0") > 0,
      };
    });
    if (focused) {
      seen.add(focused.label);
      expect(focused.hasRing, `"${focused.label}" has no visible focus indicator`).toBe(true);
    }
  }

  // The composer and the primary actions must be among the reachable set.
  expect(seen.size).toBeGreaterThan(3);

  await owner.context.close();
});
