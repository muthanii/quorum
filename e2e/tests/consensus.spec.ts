/**
 * The product (CLAUDE.md §6): nothing an agent does takes effect until every
 * collaborator approves. Two contexts, two voters. A stages what an agent
 * turn would produce — an artifact.patch operation — as a Proposal. Both
 * surfaces show the pending state at once (card in the chat rail + dashed
 * outline on the affected artifact), one approval out of two applies
 * NOTHING, and the second approval lets the authoritative ws server apply
 * the mutation atomically for everyone.
 *
 * The second voter earns editor access through the same pipeline first:
 * invite_member proposal → unanimous approval → audited claim (see
 * helpers/board.ts elevateToEditor) — consensus is never bypassed, even in
 * test setup.
 */
import { expect, test } from "@playwright/test";

import {
  APPLIED_NOTE,
  createBoardAsGuest,
  createDocArtifact,
  createInvite,
  docTextarea,
  elevateToEditor,
  joinBoardAsGuest,
  proposalCard,
} from "../helpers/board";

test("a staged proposal blocks until every collaborator approves, then applies", async ({
  browser,
}) => {
  test.setTimeout(240_000); // two full consensus roundtrips (editor grant + agent edit)

  const a = await createBoardAsGuest(browser, "E2E consensus");
  const invite = await createInvite(a, "editor");
  const b = await joinBoardAsGuest(browser, invite.url);
  // Editor invites land as viewer — the upgrade is a vote, never silent.
  expect(b.self.role).toBe("viewer");
  await elevateToEditor(a, b);

  // A drafts a doc artifact — a direct human edit, no proposal (§6).
  const artifactId = await createDocArtifact(a.page);
  const draft = "Draft v1 — waiting on the agent's revision.";
  await docTextarea(a.page).fill(draft);
  await expect(docTextarea(b.page)).toHaveValue(draft);

  // Stage the agent's artifact.patch as a Proposal. Staged, not applied.
  const patched = "Draft v2 — rewritten by the agent, approved by everyone.";
  const title = "Agent edit: tighten the brief";
  await a.page.evaluate(
    ([targetArtifactId, nextContent, proposalTitle]) => {
      const hook = window.__quorumE2E;
      if (!hook) throw new Error("e2e hook missing — run the web app with `pnpm dev` (dev build)");
      hook.stageProposal({
        kind: "artifact_patch",
        title: proposalTitle,
        summary: "Replace the draft content with the agent's revision.",
        authorId: hook.newId("agent"),
        authorKind: "agent",
        payload: {
          kind: "artifact_patch",
          operation: {
            op: "artifact.patch",
            artifactId: targetArtifactId,
            patch: [{ op: "replace", path: "/content", value: nextContent }],
          },
        },
        affectedArtifactIds: [targetArtifactId],
      });
    },
    [artifactId, patched, title] as const,
  );

  // State is never in only one place: B gets the card in the chat rail…
  const cardB = proposalCard(b.page, title);
  await expect(cardB).toBeVisible();
  await expect(cardB.getByText("Edit artifact")).toBeVisible();
  // …AND the affected artifact simultaneously wears the dashed outline.
  const artifactOnB = b.page.getByRole("article", {
    name: /open proposal affects this artifact/,
  });
  await expect(artifactOnB).toBeVisible();
  await expect(artifactOnB.locator(".border-dashed")).toBeVisible();
  await expect(artifactOnB.getByText("Vote open")).toBeVisible();

  // A approves. One yes out of two active voters is NOT consensus.
  const cardA = proposalCard(a.page, title);
  await cardA.getByRole("button", { name: "Approve" }).click();
  await expect(cardA.getByText(/You voted approve/)).toBeVisible();
  // B watches A's vote land live while the proposal stays open, waiting on B…
  await expect(cardB.getByText(`Waiting on ${b.self.name}`)).toBeVisible();
  // …and the edit is applied NOWHERE while B has not voted.
  await expect(docTextarea(a.page)).toHaveValue(draft);
  await expect(docTextarea(b.page)).toHaveValue(draft);

  // B approves → unanimous → the ws server applies atomically…
  await cardB.getByRole("button", { name: "Approve" }).click();
  await expect(cardA.getByText(APPLIED_NOTE)).toBeVisible({ timeout: 20_000 });
  await expect(cardB.getByText(APPLIED_NOTE)).toBeVisible();
  // …and the mutation is live for BOTH contexts.
  await expect(docTextarea(a.page)).toHaveValue(patched);
  await expect(docTextarea(b.page)).toHaveValue(patched);
  // The vote is closed: dashed outline and open-vote badge are gone.
  await expect(a.page.getByRole("article", { name: /open proposal affects/ })).toHaveCount(0);
  await expect(b.page.getByRole("article", { name: /open proposal affects/ })).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});
