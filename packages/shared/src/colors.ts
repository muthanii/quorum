/**
 * Per-user identity colors. Every collaborator gets one stable color used for
 * their cursor, avatar ring, selection halo, and vote chip — the same color on
 * every client, forever, with no coordination (deterministic hash of userId).
 */

/**
 * 12 hues, evenly spread, tuned for the dark canvas (#0b0c0e): every entry
 * keeps a contrast ratio ≥ 4.5:1 against it, so a bare cursor or halo is
 * visible without relying on the name label.
 */
export const MEMBER_PALETTE = [
  "#ff6b6b", // coral
  "#ff9f43", // orange
  "#ffd43b", // yellow
  "#a9e34b", // lime
  "#51cf66", // green
  "#38d9a9", // teal
  "#3bc9db", // cyan
  "#4dabf7", // blue
  "#748ffc", // indigo
  "#9775fa", // violet
  "#da77f2", // grape
  "#f783ac", // pink
] as const;

export type MemberColor = (typeof MEMBER_PALETTE)[number];

/**
 * FNV-1a 32-bit over UTF-16 code units. Math.imul keeps the multiply in
 * 32-bit space, so the result is identical on every JS engine and platform.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable identity color for a user id. Same input → same color, everywhere. */
export function colorForUser(userId: string): MemberColor {
  return MEMBER_PALETTE[fnv1a32(userId) % MEMBER_PALETTE.length] ?? MEMBER_PALETTE[0];
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function parseHex(hex: string): [number, number, number] {
  if (!HEX_COLOR.test(hex)) {
    throw new TypeError(`invalid hex color: ${JSON.stringify(hex)}`);
  }
  const raw = hex.slice(1);
  const full =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a hex color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

const DARK_TEXT = "#0b0c0e";
const LIGHT_TEXT = "#ffffff";
const DARK_TEXT_LUMINANCE = relativeLuminance(DARK_TEXT);

/**
 * Text color to place on top of `backgroundHex` (e.g. a name label on a
 * cursor chip): whichever of near-black or white has the higher WCAG
 * contrast. Every MEMBER_PALETTE entry resolves to dark text.
 */
export function contrastingTextColor(backgroundHex: string): string {
  const lum = relativeLuminance(backgroundHex);
  const contrastWithDark = (lum + 0.05) / (DARK_TEXT_LUMINANCE + 0.05);
  const contrastWithLight = (1 + 0.05) / (lum + 0.05);
  return contrastWithDark >= contrastWithLight ? DARK_TEXT : LIGHT_TEXT;
}
