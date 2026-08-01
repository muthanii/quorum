/**
 * Regression: ISSUE-002 — the board overflowed horizontally on a phone.
 * Found by /qa on 2026-08-01.
 * Report: .gstack/qa-reports/qa-report-localhost-2026-08-01.md
 *
 * The header laid out at its natural width (563px against a 375px viewport),
 * pushing the board name off-screen, and the fixed 360px chat rail left the
 * canvas a 15px sliver. Both are invisible to unit tests and to any assertion
 * that only checks "the element exists" — the page renders fine, it just does
 * not fit. These tests measure real geometry at real viewport sizes.
 */
import { expect, test } from "@playwright/test";

import { createBoardAsGuest } from "../helpers/board";

const PHONE = { width: 375, height: 812 };
const LAPTOP = { width: 1280, height: 720 };

test("the board fits a phone viewport with no horizontal overflow", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;
  await page.setViewportSize(PHONE);

  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  // 1px of slack for sub-pixel rounding; anything more is a real overflow.
  expect(scrollWidth, "page must not scroll sideways on a phone").toBeLessThanOrEqual(
    innerWidth + 1,
  );

  await owner.context.close();
});

test("the canvas stays usable on a phone instead of collapsing behind the rail", async ({
  browser,
}) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;
  await page.setViewportSize(PHONE);

  const canvasWidth = await page
    .locator("main")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  // Pre-fix this was ~15px: 375 minus the rail's fixed 360.
  expect(canvasWidth, "canvas must not be squeezed by the chat rail").toBeGreaterThan(300);

  await owner.context.close();
});

test("the board name survives on a phone rather than truncating to nothing", async ({
  browser,
}) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;
  await page.setViewportSize(PHONE);

  const nameWidth = await page
    .locator("h1")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(nameWidth, "board name must remain readable").toBeGreaterThan(20);

  await owner.context.close();
});

test("the laptop layout keeps canvas and rail side by side", async ({ browser }) => {
  const owner = await createBoardAsGuest(browser);
  const { page } = owner;
  await page.setViewportSize(LAPTOP);

  const [canvas, rail] = await Promise.all([
    page
      .locator("main")
      .first()
      .evaluate((el) => el.getBoundingClientRect()),
    page
      .getByRole("complementary")
      .first()
      .evaluate((el) => el.getBoundingClientRect())
      .catch(() => null),
  ]);

  expect(canvas.width, "canvas should take the bulk of a laptop screen").toBeGreaterThan(600);
  if (rail) {
    // Side by side, not stacked: the rail starts to the right of the canvas.
    expect(rail.x).toBeGreaterThanOrEqual(canvas.x + canvas.width - 1);
  }

  await owner.context.close();
});
