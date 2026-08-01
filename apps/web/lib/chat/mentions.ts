/**
 * Pure @mention helpers for the composer (brief addendum #5): the `mentions`
 * field on a Message carries agent ids (agt_…), resolved from @Name tokens at
 * send time. A broadcast message carries mentions == ["*"].
 */

export const BROADCAST_MENTION = "*";

export interface MentionTarget {
  id: string;
  name: string;
}

const WORD_CHAR = /[\w]/;

/**
 * Resolve every @Name occurrence in `content` to its target id. Matching is
 * case-insensitive and boundary-aware: "@Researcher" never also matches a
 * target named "Res", and names may contain spaces ("@Research Bot").
 */
export function extractMentions(content: string, targets: readonly MentionTarget[]): string[] {
  const lower = content.toLowerCase();
  const found: string[] = [];
  for (const target of targets) {
    if (target.name === "") continue;
    const token = `@${target.name.toLowerCase()}`;
    let idx = lower.indexOf(token);
    while (idx !== -1) {
      const before = idx === 0 ? undefined : lower[idx - 1];
      const after = lower[idx + token.length];
      const beforeOk = before === undefined || (!WORD_CHAR.test(before) && before !== "@");
      const afterOk = after === undefined || !WORD_CHAR.test(after);
      if (beforeOk && afterOk) {
        found.push(target.id);
        break;
      }
      idx = lower.indexOf(token, idx + 1);
    }
  }
  return found;
}

export interface MentionQuery {
  /** The partial name typed after "@" (may be empty right after typing "@"). */
  query: string;
  /** Index of the "@" character in the text. */
  start: number;
}

const ACTIVE_MENTION = /(^|\s)@([\w-]{0,32})$/;

/**
 * The in-progress @mention token immediately before the caret, or null when
 * the caret is not inside one (an "@" must start the text or follow
 * whitespace, so emails never trigger the popover).
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, caret));
  const match = ACTIVE_MENTION.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { query, start: before.length - query.length - 1 };
}
