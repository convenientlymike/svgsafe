/**
 * Diagnose the SVG-on-mobile traps that clip or break a card in iOS Safari and
 * iOS in-app webviews (Instagram, Facebook, …) while looking perfect on desktop
 * Chrome — the failure mode that's almost impossible to catch without knowing the
 * specific WebKit quirks.
 */
import { inspect } from "./svg.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  fix: string;
}

export interface Report {
  findings: Finding[];
  ok: boolean; // true when there are no `error`-level findings
}

export function doctor(source: string): Report {
  const info = inspect(source);
  const findings: Finding[] = [];

  // 1) No viewBox on the root → WebKit won't scale an SVG-in-<img>; it paints at
  //    intrinsic width and clips. (Chromium scales anyway, hiding it on desktop.)
  if (!info.hasViewBox) {
    findings.push({
      severity: "error",
      code: "no-viewbox",
      message:
        "root <svg> has no viewBox — in an <img>, WebKit/iOS paints it at its " +
        "intrinsic size and clips instead of scaling (desktop Chrome hides this).",
      fix:
        info.width != null && info.height != null
          ? `add viewBox="0 0 ${info.width} ${info.height}" (run: svgsafe fix)`
          : "add a viewBox matching the content bounds (run: svgsafe fix)",
    });
  }

  // 2) foreignObject sized in % → iOS Safari fails to resolve the percentage, the
  //    inner HTML lays out at its natural width and overflows the canvas → clipped.
  if (info.foreignObject) {
    const pct = (v: string | null) => v != null && v.trim().endsWith("%");
    if (pct(info.foWidth) || pct(info.foHeight)) {
      findings.push({
        severity: "error",
        code: "foreignobject-percent",
        message:
          `<foreignObject> is sized in % (width="${info.foWidth}" height="${info.foHeight}"). ` +
          "iOS Safari + in-app webviews don't resolve that against the SVG viewport, " +
          "so the HTML overflows and the right edge is clipped on iPhone. " +
          "(macOS Safari/Quick Look DO resolve it — a false-clean.)",
        fix:
          info.width != null && info.height != null
            ? `pin it to width="${info.width}" height="${info.height}" (run: svgsafe fix)`
            : "pin the foreignObject to explicit pixel width/height (run: svgsafe fix)",
      });
    } else if (info.foWidth == null || info.foHeight == null) {
      findings.push({
        severity: "warn",
        code: "foreignobject-unsized",
        message:
          "<foreignObject> has no explicit width/height — sizing is left to the " +
          "engine and can diverge between Chromium and WebKit.",
        fix: "pin it to explicit pixel width/height (run: svgsafe fix)",
      });
    }
  }

  // 3) Foreign-object SVGs are inherently engine-fragile on mobile; a raster is
  //    the bullet-proof option when it must render on iOS.
  if (info.foreignObject) {
    findings.push({
      severity: "info",
      code: "prefer-raster-on-mobile",
      message:
        "this SVG embeds HTML via <foreignObject>; for a card that MUST render on " +
        "iOS, a raster removes all engine risk (and your desktop check becomes " +
        "authoritative for mobile).",
      fix: "rasterize: svgsafe render <file> --scale 3",
    });
  }

  // 4) Embedding reminder (can't be detected from the SVG, but it's the #1 cause
  //    of mobile clipping after the above): never embed at a fixed pixel width.
  findings.push({
    severity: "info",
    code: "embed-responsive",
    message:
      "embed with width=\"100%\" (not a fixed px) so the image can never exceed a " +
      "narrow webview's viewport.",
    fix: 'use <img src="…" width="100%"> in HTML/Markdown',
  });

  return { findings, ok: !findings.some((f) => f.severity === "error") };
}