/**
 * Rasterize an SVG to a crisp, transparent PNG by driving an installed Chrome in
 * headless screenshot mode. No browser download, no runtime dependencies.
 *
 * Why a raster: an SVG that embeds HTML via <foreignObject> renders inconsistently
 * across engines (see doctor); a PNG renders identically everywhere and scales
 * cleanly with width="100%". We render at a device-scale-factor so it stays crisp
 * when downscaled on Retina displays.
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  copyFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "./svg.js";
import { resolveChrome } from "./chrome.js";

export interface RenderOptions {
  scale?: number; // device-scale-factor (default 3)
  out?: string; // output path (default: <input>.png)
  chrome?: string; // explicit binary
}

export interface RenderResult {
  out: string;
  width: number;
  height: number;
  chrome: string;
}

/** Read a PNG's pixel size + whether it carries an alpha channel (color type 6). */
function inspectPng(path: string): { width: number; height: number; rgba: boolean } {
  const buf = readFileSync(path);
  if (buf.length < 26 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${path} is not a valid PNG`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    rgba: buf[25] === 6, // IHDR color type 6 = truecolor + alpha
  };
}

export function render(svgPath: string, opts: RenderOptions = {}): RenderResult {
  const input = resolve(svgPath);
  if (!existsSync(input)) throw new Error(`no such file: ${svgPath}`);

  const scale = opts.scale ?? 3;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`invalid --scale: ${opts.scale}`);
  const out = resolve(opts.out ?? input.replace(/\.svg$/i, "") + ".png");

  const source = readFileSync(input, "utf8");
  const info = inspect(source);
  // Prefer the viewBox bounds, else width/height. We need a concrete pixel canvas.
  let w = info.width;
  let h = info.height;
  if ((w == null || h == null) && info.viewBox) {
    const parts = info.viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4) {
      w = Math.round(parts[2]);
      h = Math.round(parts[3]);
    }
  }
  if (w == null || h == null) {
    throw new Error("could not determine SVG size (need width/height or a viewBox)");
  }

  const chrome = opts.chrome ?? resolveChrome();
  if (!chrome) {
    throw new Error(
      "no Chrome/Chromium found. Install Google Chrome, or set $SVGSAFE_CHROME to a binary.",
    );
  }

  const profile = mkdtempSync(join(tmpdir(), "svgsafe-"));
  // Chrome only ever touches $TMPDIR — never the input/output directory. On macOS
  // that avoids a TCC "<browser> would like to access files in your Desktop/
  // Documents/Downloads folder" prompt (which blocks a headless launch). We copy
  // the SVG in, render to a temp PNG, then move it out with Node (which already
  // has the caller's file permissions).
  const workSvg = join(profile, "input.svg");
  const workPng = join(profile, "output.png");
  const logPath = join(profile, "chrome.log");
  copyFileSync(input, workSvg);
  const logFd = openSync(logPath, "w");
  try {
    execFileSync(
      chrome,
      [
        // OLD headless: it honors the `--screenshot` CLI shortcut and
        // `--virtual-time-budget`, capturing and exiting immediately. NEW headless
        // launches a full browser that ignores virtual-time and never exits after
        // --screenshot (it even starts GCM/push registration) → hang.
        "--headless=old",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage", // small /dev/shm on CI/containers hangs Chrome
        "--no-first-run",
        "--no-default-browser-check",
        // Don't touch the OS keychain. On macOS a fresh profile otherwise pops a
        // password prompt for "Chrome Safe Storage" and BLOCKS the headless launch
        // (it hangs until dismissed). A mock keychain skips that entirely.
        "--use-mock-keychain",
        "--password-store=basic",
        "--hide-scrollbars",
        `--user-data-dir=${profile}`,
        "--default-background-color=00000000", // transparent RGBA
        `--force-device-scale-factor=${scale}`,
        `--window-size=${Math.round(w)},${Math.round(h)}`,
        // Bound the wait: new headless otherwise blocks until the page is fully
        // "loaded" (e.g. waiting on unresolved system fonts on a clean runner) and
        // never captures/exits. virtual-time advances the page clock and forces a
        // capture, so Chrome reliably screenshots and quits within the budget.
        "--virtual-time-budget=10000",
        "--run-all-compositor-stages-before-draw",
        `--screenshot=${workPng}`,
        pathToFileURL(workSvg).href,
      ],
      // stderr -> a FILE (not a pipe): captures Chrome's diagnostics without the
      // pipe-buffer deadlock a flood of stderr would cause. timeout is a backstop
      // so a wedged Chrome can't hang forever.
      // SIGKILL on timeout: a Chrome blocked on a system modal (e.g. a macOS
      // keychain prompt) ignores the default SIGTERM and would hang forever.
      { stdio: ["ignore", "ignore", logFd], timeout: 45_000, killSignal: "SIGKILL" },
    );
    if (!existsSync(workPng)) throw new Error("Chrome produced no output PNG");
    copyFileSync(workPng, out); // move it out of $TMPDIR with the caller's perms
  } catch (err) {
    let detail = (err as Error).message;
    try {
      const log = readFileSync(logPath, "utf8").trim();
      if (log) detail += "\n  chrome: " + log.split("\n").slice(-4).join("\n  chrome: ");
    } catch {
      /* no log captured */
    }
    throw new Error(`Chrome failed to render: ${detail}`);
  } finally {
    try {
      closeSync(logFd);
    } catch {
      /* already closed */
    }
    // Best-effort: Chrome's helper/crashpad processes can briefly outlive the main
    // process and keep writing to the profile dir, racing our cleanup (ENOTEMPTY /
    // EBUSY). Retry, and never let a temp-cleanup failure fail a successful render.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* leftover temp dir; the OS reclaims it */
    }
  }

  const png = inspectPng(out);
  if (!png.rgba) {
    throw new Error("output PNG is not transparent (RGBA) — transparency was lost");
  }
  return { out, width: png.width, height: png.height, chrome };
}