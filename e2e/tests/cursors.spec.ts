/**
 * Multiplayer cursors (CLAUDE.md §7/§10): two browser contexts on one board;
 * context B sees context A's cursor — carrying A's name label — and sees it
 * MOVE when A moves. Cursor positions travel in canvas world coordinates via
 * awareness, so both contexts agree on where the cursor is.
 */
import { expect, test } from "@playwright/test";

import { createBoardAsGuest, createInvite, joinBoardAsGuest } from "../helpers/board";

test("context B sees context A's named cursor move", async ({ browser }) => {
  const a = await createBoardAsGuest(browser, "E2E cursors");
  const invite = await createInvite(a, "viewer");
  const b = await joinBoardAsGuest(browser, invite.url);

  const canvasA = a.page.getByRole("region", { name: "Canvas" });
  const canvasBox = await canvasA.boundingBox();
  if (!canvasBox) throw new Error("canvas has no bounding box");

  // A moves the pointer across the canvas (top-left region, clear of the
  // centered empty-state card). Multiple steps fire real pointermove events.
  await a.page.mouse.move(canvasBox.x + 150, canvasBox.y + 150, { steps: 8 });

  // B sees a cursor labeled with A's name — color is never the only signal.
  const labelOnB = b.page.getByRole("region", { name: "Canvas" }).getByText(a.self.name, {
    exact: true,
  });
  await expect(labelOnB).toBeVisible({ timeout: 5_000 });

  const positionBefore = await labelOnB.boundingBox();
  if (!positionBefore) throw new Error("cursor label has no bounding box");

  // A moves again; B's copy of the cursor follows (interpolated, not teleported).
  await a.page.mouse.move(canvasBox.x + 340, canvasBox.y + 260, { steps: 8 });
  await expect
    .poll(
      async () => {
        const box = await labelOnB.boundingBox();
        if (!box) return 0;
        return Math.hypot(box.x - positionBefore.x, box.y - positionBefore.y);
      },
      { timeout: 5_000, message: "A's cursor should move on B's screen" },
    )
    .toBeGreaterThan(50);

  await a.context.close();
  await b.context.close();
});
