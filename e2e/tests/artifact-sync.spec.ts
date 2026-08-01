/**
 * Live artifact sync (CLAUDE.md §1 principle 4, §10): A creates a doc
 * artifact and types into it — direct collaborative editing, never a
 * proposal — and B sees the artifact and its content appear live, well
 * inside the 2-second budget asserted here (product target is <150ms p95;
 * 2s is the hard ceiling this suite enforces).
 */
import { expect, test } from "@playwright/test";

import {
  createBoardAsGuest,
  createDocArtifact,
  createInvite,
  docTextarea,
  joinBoardAsGuest,
} from "../helpers/board";

test("B sees A's doc artifact and its content live (<2s)", async ({ browser }) => {
  const a = await createBoardAsGuest(browser, "E2E artifact sync");
  const invite = await createInvite(a, "viewer");
  const b = await joinBoardAsGuest(browser, invite.url);

  // A creates the artifact; it appears on B's canvas within the budget.
  await createDocArtifact(a.page);
  await expect(
    b.page.getByRole("article", { name: /Document artifact: Untitled doc/ }),
  ).toBeVisible({ timeout: 2_000 });

  // A writes; B reads it live. fill() lands the whole draft as one edit…
  const draft = "Q3 brief: ship nothing without everyone's yes.";
  await docTextarea(a.page).fill(draft);
  await expect(docTextarea(b.page)).toHaveValue(draft, { timeout: 2_000 });

  // …and per-keystroke edits stream through the CRDT the same way.
  await docTextarea(a.page).pressSequentially(" Typed live.");
  await expect(docTextarea(b.page)).toHaveValue(`${draft} Typed live.`, { timeout: 2_000 });

  // B is a viewer: same content, explicitly read-only — never a dead editor.
  await expect(docTextarea(b.page)).toHaveAttribute("readonly", "");

  await a.context.close();
  await b.context.close();
});
