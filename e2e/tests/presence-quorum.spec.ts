/**
 * Quorum recalculation is SHOWN, never silent (CLAUDE.md §6): the header's
 * "N voting" chip counts members who are connected or seen within the
 * 5-minute active window. A watches it grow when B becomes a connected
 * editor, and watches it shrink after B disconnects and ages out of the
 * window. The age-out phase makes this an intentionally SLOW test (~6-7
 * minutes): a brief disconnect must NEVER silently shrink the quorum, so
 * the drop can only be observed after the full window elapses.
 */
import { expect, test } from "@playwright/test";

import {
  createBoardAsGuest,
  createInvite,
  elevateToEditor,
  joinBoardAsGuest,
  quorumIndicator,
} from "../helpers/board";

test("A sees the active quorum recalculate when B joins and when B drops", async ({ browser }) => {
  test.setTimeout(10 * 60 * 1000); // see header comment — the age-out is 5 minutes by design

  const a = await createBoardAsGuest(browser, "E2E presence quorum");
  // The owner alone: a voting quorum of one.
  await expect(quorumIndicator(a.page)).toHaveText(/1 voting/);

  const invite = await createInvite(a, "editor");
  const b = await joinBoardAsGuest(browser, invite.url);
  // B lands as a viewer, and viewers hold no vote — still a quorum of one.
  await expect(quorumIndicator(a.page)).toHaveText(/1 voting/);

  await elevateToEditor(a, b);
  // B is now a connected editor. A's membership snapshot refreshes on a 60s
  // cadence, so give the chip up to ~90s to recalculate upward.
  await expect(quorumIndicator(a.page)).toHaveText(/2 voting/, { timeout: 90_000 });

  // B disconnects (context closed = tab gone). B was seen just now, so the
  // 5-minute window keeps them counted at first…
  await b.context.close();
  await expect(quorumIndicator(a.page)).toHaveText(/2 voting/);
  // …and once they age out of the window, A SEES the quorum shrink to one.
  await expect(quorumIndicator(a.page)).toHaveText(/1 voting/, { timeout: 7 * 60 * 1000 });

  await a.context.close();
});
