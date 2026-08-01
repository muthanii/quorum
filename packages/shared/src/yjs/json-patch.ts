/**
 * Minimal RFC 6902 JSON Patch applier for staged artifact.patch operations.
 * Pure: never mutates its input — the caller gets a fresh document back, so
 * a failing patch can be discarded without touching the Y.Doc (atomicity).
 */
import type { JsonPatchOp, JsonValue } from "@quorum/agent-protocol/v1/types";

/** RFC 6901 pointer → tokens ("" → [], "/a/~1b" → ["a", "/b"]). */
function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new Error(`invalid JSON pointer: ${JSON.stringify(pointer)}`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayIndex(token: string, length: number, allowEnd: boolean): number {
  if (token === "-" && allowEnd) return length;
  if (!/^(0|[1-9]\d*)$/.test(token)) {
    throw new Error(`invalid array index: ${JSON.stringify(token)}`);
  }
  const index = Number(token);
  const max = allowEnd ? length : length - 1;
  if (index > max) throw new Error(`array index out of bounds: ${index}`);
  return index;
}

/** Walk to the parent of the pointer target. Throws when the path is absent. */
function getParent(root: JsonValue, tokens: string[]): { parent: JsonValue; key: string } {
  const key = tokens[tokens.length - 1];
  if (key === undefined) throw new Error("cannot address the document root here");
  let parent = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(parent)) {
      const next = parent[arrayIndex(token, parent.length, false)];
      if (next === undefined) throw new Error(`path not found at ${JSON.stringify(token)}`);
      parent = next;
    } else if (isRecord(parent)) {
      const next = parent[token];
      if (next === undefined) throw new Error(`path not found at ${JSON.stringify(token)}`);
      parent = next;
    } else {
      throw new Error(`cannot traverse into a primitive at ${JSON.stringify(token)}`);
    }
  }
  return { parent, key };
}

function getAt(root: JsonValue, tokens: string[]): JsonValue {
  if (tokens.length === 0) return root;
  const { parent, key } = getParent(root, tokens);
  let value: JsonValue | undefined;
  if (Array.isArray(parent)) {
    value = parent[arrayIndex(key, parent.length, false)];
  } else if (isRecord(parent)) {
    value = parent[key];
  }
  if (value === undefined) throw new Error(`path not found at ${JSON.stringify(key)}`);
  return value;
}

function addAt(root: JsonValue, tokens: string[], value: JsonValue): JsonValue {
  if (tokens.length === 0) return value; // whole-document replacement
  const { parent, key } = getParent(root, tokens);
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(key, parent.length, true), 0, value);
  } else if (isRecord(parent)) {
    parent[key] = value;
  } else {
    throw new Error("cannot add into a primitive value");
  }
  return root;
}

function removeAt(root: JsonValue, tokens: string[]): JsonValue {
  if (tokens.length === 0) throw new Error("cannot remove the document root");
  const { parent, key } = getParent(root, tokens);
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(key, parent.length, false), 1);
  } else if (isRecord(parent)) {
    if (!(key in parent)) throw new Error(`cannot remove missing key ${JSON.stringify(key)}`);
    delete parent[key];
  } else {
    throw new Error("cannot remove from a primitive value");
  }
  return root;
}

function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i] as JsonValue));
  }
  if (isRecord(a) && isRecord(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return (
      keysA.length === keysB.length &&
      keysA.every((key) => key in b && deepEqual(a[key] as JsonValue, b[key] as JsonValue))
    );
  }
  return false;
}

/**
 * Apply an RFC 6902 patch to a JSON document. Returns a new document; throws
 * on any invalid operation (bad pointer, missing path, failed test) without
 * having touched the input.
 */
export function applyJsonPatch(target: JsonValue, patch: readonly JsonPatchOp[]): JsonValue {
  let root = structuredClone(target) as JsonValue;
  for (const op of patch) {
    const tokens = parsePointer(op.path);
    switch (op.op) {
      case "add":
        root = addAt(root, tokens, structuredClone(op.value) as JsonValue);
        break;
      case "remove":
        root = removeAt(root, tokens);
        break;
      case "replace": {
        const value = structuredClone(op.value) as JsonValue;
        if (tokens.length === 0) {
          root = value;
          break;
        }
        const { parent, key } = getParent(root, tokens);
        if (Array.isArray(parent)) {
          parent[arrayIndex(key, parent.length, false)] = value;
        } else if (isRecord(parent)) {
          // RFC 6902 §4.3: the target location must exist.
          if (!(key in parent))
            throw new Error(`cannot replace missing key ${JSON.stringify(key)}`);
          parent[key] = value;
        } else {
          throw new Error("cannot replace inside a primitive value");
        }
        break;
      }
      case "move": {
        const fromTokens = parsePointer(op.from);
        const moved = structuredClone(getAt(root, fromTokens)) as JsonValue;
        root = removeAt(root, fromTokens);
        root = addAt(root, tokens, moved);
        break;
      }
      case "copy": {
        const copied = structuredClone(getAt(root, parsePointer(op.from))) as JsonValue;
        root = addAt(root, tokens, copied);
        break;
      }
      case "test":
        if (!deepEqual(getAt(root, tokens), op.value)) {
          throw new Error(`test failed at ${JSON.stringify(op.path)}`);
        }
        break;
    }
  }
  return root;
}
