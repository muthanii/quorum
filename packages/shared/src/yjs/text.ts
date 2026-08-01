import type * as Y from "yjs";

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Set a Y.Text to `nextValue` with the smallest possible edit: trim the
 * common prefix and suffix, then one delete + one insert of the differing
 * middle. Minimal edits keep CRDT history small and let concurrent edits from
 * other peers merge instead of being clobbered by a full rewrite.
 *
 * Indices are UTF-16 code units (Y.Text's native unit); the boundaries are
 * nudged so a surrogate pair is never split.
 */
export function updateYText(ytext: Y.Text, nextValue: string): void {
  const current = ytext.toString();
  if (current === nextValue) return;

  let prefix = 0;
  const maxPrefix = Math.min(current.length, nextValue.length);
  while (prefix < maxPrefix && current.charCodeAt(prefix) === nextValue.charCodeAt(prefix)) {
    prefix++;
  }
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) {
    prefix--;
  }

  let suffix = 0;
  const maxSuffix = Math.min(current.length, nextValue.length) - prefix;
  while (
    suffix < maxSuffix &&
    current.charCodeAt(current.length - 1 - suffix) ===
      nextValue.charCodeAt(nextValue.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) {
    suffix--;
  }

  const deleteLength = current.length - prefix - suffix;
  const insertText = nextValue.slice(prefix, nextValue.length - suffix);

  const apply = () => {
    if (deleteLength > 0) ytext.delete(prefix, deleteLength);
    if (insertText.length > 0) ytext.insert(prefix, insertText);
  };
  // One transaction so remote peers see a single atomic splice. Nested
  // transact calls collapse into the caller's transaction.
  if (ytext.doc) {
    ytext.doc.transact(apply);
  } else {
    apply();
  }
}
