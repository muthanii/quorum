/**
 * Shared setup for the multiplayer specs: create a board as an anonymous
 * guest, invite a second browser context through a real invite link, and —
 * when a spec needs two VOTERS — walk the second guest through the product's
 * own consensus pipeline to editor access (invite_member proposal → unanimous
 * approval → ws-audited resolution → claim). Nothing here bypasses consensus.
 *
 * All REST calls go through page.request, which shares the browser context's
 * cookie jar — the guest identity minted by the API is the same one the page
 * then uses.
 */
import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";

/** Resolved-proposal copy rendered by ProposalCard — asserted verbatim. */
export const APPLIED_NOTE = "Approved — the change was applied to the board.";

// ---------------------------------------------------------------------------
// Wire-shape mirrors (e2e depends only on @playwright/test, so the few DTO
// fields the suite reads are mirrored here instead of imported from apps/web)
// ---------------------------------------------------------------------------

export interface BoardSelf {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  color: string;
}

interface BoardDetailResponse {
  board: { id: string; name: string; ownerId: string };
  self: BoardSelf;
}

interface CreateBoardResponse {
  board: { id: string };
}

interface CreateInviteResponse {
  token: string;
  role: "editor" | "viewer";
  url: string;
}

/**
 * Mirror of the dev-only window hook installed by apps/web/lib/yjs/e2e-hook.ts.
 * Staging-only: proposals enter the pipeline here; the ws server resolves.
 */
interface QuorumE2EHookMirror {
  stageProposal(input: {
    kind: string;
    title: string;
    summary: string;
    authorId: string;
    authorKind: "human" | "agent";
    payload: unknown;
    affectedArtifactIds: string[];
    timeoutMs?: number;
  }): { id: string };
  listArtifacts(): Array<{ id: string; meta: { title: string; type: string } }>;
  newId(kind: string): string;
}

declare global {
  interface Window {
    __quorumE2E?: QuorumE2EHookMirror;
  }
}

// ---------------------------------------------------------------------------
// Board sessions
// ---------------------------------------------------------------------------

export interface Collaborator {
  context: BrowserContext;
  page: Page;
  boardId: string;
  /** This context's guest identity on the board (refreshed after reloads). */
  self: BoardSelf;
}

/** The Y.Doc has synced and the ws connection is live. */
export async function waitForBoardReady(page: Page): Promise<void> {
  await expect(page.getByRole("region", { name: "Canvas" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Connecting to the board…", { exact: true })).toBeHidden({
    timeout: 30_000,
  });
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 30_000 });
}

async function fetchSelf(page: Page, boardId: string): Promise<BoardSelf> {
  const response = await page.request.get(`/api/boards/${boardId}`);
  if (!response.ok()) {
    throw new Error(`GET /api/boards/${boardId} failed: ${response.status()}`);
  }
  const detail = (await response.json()) as BoardDetailResponse;
  return detail.self;
}

/**
 * New browser context → guest identity + board via POST /api/boards (guests
 * are first-class: the API mints the identity and the quorum_guest cookie),
 * then open the board and wait for the live connection.
 */
export async function createBoardAsGuest(
  browser: Browser,
  name = "E2E board",
): Promise<Collaborator> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.request.post("/api/boards", { data: { name } });
  if (response.status() !== 201) {
    throw new Error(`POST /api/boards failed: ${response.status()} ${await response.text()}`);
  }
  const { board } = (await response.json()) as CreateBoardResponse;
  await page.goto(`/b/${board.id}`);
  await waitForBoardReady(page);
  const self = await fetchSelf(page, board.id);
  return { context, page, boardId: board.id, self };
}

/** One-click share: mint an invite link from an existing member's context. */
export async function createInvite(
  member: Collaborator,
  role: "editor" | "viewer",
): Promise<CreateInviteResponse> {
  const response = await member.page.request.post(`/api/boards/${member.boardId}/invites`, {
    data: { role },
  });
  if (response.status() !== 201) {
    throw new Error(`POST invites failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as CreateInviteResponse;
}

/**
 * Second context joins through /i/<token> exactly like a shared link: the
 * accept route mints the guest identity + membership and redirects into the
 * board. Editor invites still land as viewer — the upgrade is a consensus
 * vote (see elevateToEditor), never a silent grant.
 */
export async function joinBoardAsGuest(browser: Browser, inviteUrl: string): Promise<Collaborator> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(inviteUrl);
  await page.waitForURL(/\/b\/brd_[A-Za-z0-9_-]{16}/);
  const match = /\/b\/(brd_[A-Za-z0-9_-]{16})/.exec(page.url());
  if (!match || match[1] === undefined) {
    throw new Error(`expected a board URL after accepting the invite, got ${page.url()}`);
  }
  const boardId = match[1];
  await waitForBoardReady(page);
  const self = await fetchSelf(page, boardId);
  return { context, page, boardId, self };
}

// ---------------------------------------------------------------------------
// Consensus-driven editor access for the second context
// ---------------------------------------------------------------------------

/** The proposal card in the chat rail, addressed by its accessible name. */
export function proposalCard(page: Page, title: string): Locator {
  return page.getByRole("article", { name: `Proposal: ${title}` });
}

/**
 * Give the invited guest a vote, through the product's own pipeline:
 * 1. the owner stages an invite_member proposal for the guest (the guest's
 *    own staging is dropped by the ws server — viewer connections are
 *    read-only — so the writing side stages it, via the dev-only hook),
 * 2. the owner (the only active voter — viewers hold no vote) approves,
 * 3. the ws server resolves, applies, and AUDITS the resolution to Postgres,
 * 4. the guest claims the audited grant (viewer → editor) and reloads to
 *    reconnect with a writable editor token.
 */
export async function elevateToEditor(owner: Collaborator, guest: Collaborator): Promise<void> {
  const title = `Grant editor access to ${guest.self.name}`;
  await owner.page.evaluate(
    ([guestId, guestName, proposalTitle]) => {
      const hook = window.__quorumE2E;
      if (!hook) throw new Error("e2e hook missing — run the web app with `pnpm dev` (dev build)");
      hook.stageProposal({
        kind: "invite_member",
        title: proposalTitle,
        summary: `${guestName} joined through an editor invite link.`,
        authorId: guestId,
        authorKind: "human",
        payload: { kind: "invite_member", role: "editor" },
        affectedArtifactIds: [],
      });
    },
    [guest.self.id, guest.self.name, title] as const,
  );

  const card = proposalCard(owner.page, title);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText(APPLIED_NOTE)).toBeVisible({ timeout: 20_000 });

  // The ws server audits to Postgres just after writing the doc status —
  // poll the claim endpoint across that gap. 409 = not audited yet.
  await expect
    .poll(
      async () => {
        const response = await guest.page.request.post(
          `/api/boards/${guest.boardId}/members/claim-editor`,
        );
        return response.status();
      },
      { timeout: 15_000, message: "claim-editor should succeed once the resolution is audited" },
    )
    .toBe(200);

  // Reconnect with an editor token (role is read at page load / token mint).
  await guest.page.reload();
  await waitForBoardReady(guest.page);
  guest.self = await fetchSelf(guest.page, guest.boardId);
  expect(guest.self.role).toBe("editor");
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

/**
 * Create a doc artifact the way a human does (the empty-state "New doc"
 * button — a direct CRDT write, never a proposal) and return its id.
 */
export async function createDocArtifact(page: Page): Promise<string> {
  await page.getByRole("button", { name: "New doc" }).click();
  await expect(
    page.getByRole("article", { name: /Document artifact: Untitled doc/ }),
  ).toBeVisible();
  return page.evaluate(() => {
    const hook = window.__quorumE2E;
    if (!hook) throw new Error("e2e hook missing — run the web app with `pnpm dev` (dev build)");
    const artifact = hook.listArtifacts().find((entry) => entry.meta.type === "doc");
    if (!artifact) throw new Error("doc artifact not found in the live doc");
    return artifact.id;
  });
}

/** The editable body of the (sole) doc artifact on the canvas. */
export function docTextarea(page: Page): Locator {
  return page.getByRole("textbox", { name: /Untitled doc/ });
}

/** The header chip showing how many members currently count toward consensus. */
export function quorumIndicator(page: Page): Locator {
  return page.getByTitle(/Members counted toward consensus/);
}
