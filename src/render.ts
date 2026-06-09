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
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
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
  try {
    execFileSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        `--user-data-dir=${profile}`,
        "--default-background-color=00000000", // transparent RGBA
        `--force-device-scale-factor=${scale}`,
        `--window-size=${Math.round(w)},${Math.round(h)}`,
        `--screenshot=${out}`,
        pathToFileURL(input).href,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (err) {
    throw new Error(`Chrome failed to render: ${(err as Error).message}`);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }

  if (!existsSync(out)) throw new Error("Chrome produced no output PNG");
  const png = inspectPng(out);
  if (!png.rgba) {
    throw new Error("output PNG is not transparent (RGBA) — transparency was lost");
  }
  return { out, width: png.width, height: png.height, chrome };
}