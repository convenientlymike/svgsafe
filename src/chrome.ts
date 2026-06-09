/**
 * Resolve an installed Chrome/Chromium binary WITHOUT downloading one.
 *
 * svgsafe never bundles or downloads a browser — it drives whatever Chrome you
 * already have (system Chrome, Chrome for Testing, Chromium, or Edge). Override
 * with $SVGSAFE_CHROME or $CHROME_PATH.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

/** Cross-platform PATH lookup — pure Node, no shelling to bash/where. */
function fromPath(...names: string[]): string | null {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    platform() === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = join(dir, name + ext);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

/** Newest Chrome-for-Testing binary in the Playwright cache, if present. */
function chromeForTesting(): string | null {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  if (!existsSync(cache)) return null;
  const leaf =
    platform() === "darwin"
      ? join(
          "chrome-mac-arm64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        )
      : join("chrome-linux", "chrome");
  const dirs = readdirSync(cache)
    .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
    .sort()
    .reverse();
  for (const d of dirs) {
    const bin = join(cache, d, leaf);
    if (existsSync(bin)) return bin;
  }
  return null;
}

export function resolveChrome(): string | null {
  for (const env of [process.env.SVGSAFE_CHROME, process.env.CHROME_PATH]) {
    if (env && existsSync(env)) return env;
  }

  const candidates: string[] = [];
  const os = platform();
  if (os === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (os === "win32") {
    const pf = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
    const pfx = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    candidates.push(
      `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pfx}\\Google\\Chrome\\Application\\chrome.exe`,
      `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    );
  }
  for (const c of candidates) if (existsSync(c)) return c;

  const cft = chromeForTesting();
  if (cft) return cft;

  return fromPath(
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "msedge",
  );
}