/**
 * Auto-repair the two structural traps doctor flags, in place and idempotently:
 *   1. add a viewBox to the root <svg> (derived from its width/height), and
 *   2. pin the root <foreignObject> to explicit pixels (matching the canvas).
 *
 * Only the first <svg> and first <foreignObject> are touched; nested icon <svg>s
 * are left alone. Re-running on a fixed file is a no-op.
 */
import { inspect, replaceTag } from "./svg.js";

export interface FixResult {
  source: string;
  changed: boolean;
  applied: string[];
}

/** Set foreignObject width/height to explicit px when they're %-valued or missing. */
function pinForeignObject(tag: string, w: number, h: number): string {
  let t = tag;
  const pinned = (dim: "width" | "height", px: number): void => {
    const has = new RegExp(`\\b${dim}="[^"]*"`).test(t);
    const isPct = new RegExp(`\\b${dim}="[^"]*%"`).test(t);
    if (isPct) {
      t = t.replace(new RegExp(`\\b${dim}="[^"]*"`), `${dim}="${px}"`);
    } else if (!has) {
      t = t.replace(/<foreignObject\b/, `<foreignObject ${dim}="${px}"`);
    }
  };
  pinned("width", w);
  pinned("height", h);
  return t;
}

export function fix(source: string): FixResult {
  const info = inspect(source);
  const applied: string[] = [];

  // Without intrinsic dimensions we can't safely derive a viewBox or px size.
  // (A viewBox-only SVG is already scalable, so there's nothing to repair.)
  if (info.width == null || info.height == null) {
    return { source, changed: false, applied };
  }
  const W = info.width;
  const H = info.height;
  let out = source;

  if (!info.hasViewBox) {
    const next = replaceTag(out, "svg", (tag) => tag.replace(/>$/, ` viewBox="0 0 ${W} ${H}">`));
    if (next !== out) {
      out = next;
      applied.push(`added viewBox="0 0 ${W} ${H}"`);
    }
  }

  if (info.foreignObject) {
    const next = replaceTag(out, "foreignObject", (tag) => pinForeignObject(tag, W, H));
    if (next !== out) {
      out = next;
      applied.push(`pinned foreignObject to ${W}x${H}`);
    }
  }

  return { source: out, changed: out !== source, applied };
}