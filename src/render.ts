/**
 * Rasterize an SVG to a crisp, transparent PNG by driving an installed Chrome over the
 * DevTools Protocol (CDP) — NOT the `--screenshot` CLI flag.
 *
 * Why CDP: across Chrome versions the `--screenshot` shortcut is hopelessly
 * inconsistent (`--headless=new` never exits after a capture; `--headless=old` is gone
 * on bleeding-edge snapshots; which one screenshots-and-exits flips per build). CDP
 * sidesteps all of it: open the SVG, capture, and call `Browser.close` ourselves —
 * version-proof. Still no browser download (drives an installed Chrome); zero runtime
 * deps (Node ≥22's built-in WebSocket + fetch).
 *
 * Hardened against every cross-OS hang this was built through: mock keychain, no
 * background networking, no /dev/shm, --no-sandbox on Linux only (it breaks macOS
 * headless IPC), a fresh $TMPDIR profile, file:// navigation, Chrome stderr captured to
 * a log and surfaced on failure, and a hard timeout that rejects (never hangs).
 */
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  copyFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
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

const LAUNCH_FLAGS = [
  "--headless=new",
  "--remote-debugging-port=0",
  "--disable-gpu",
  // --no-sandbox is required on Linux CI (root) but BREAKS macOS headless (Mach-port
  // rendezvous failure: "No rendezvous client, parent died?"). Linux only.
  ...(platform() === "linux" ? ["--no-sandbox"] : []),
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--use-mock-keychain",
  "--password-store=basic",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-component-update",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-features=Translate,ChromeWhatsNewUI",
  "--hide-scrollbars",
  "--mute-audio",
];

const CALL_TIMEOUT = 15_000;
const TOTAL_TIMEOUT = 35_000;

function inspectPng(path: string): { width: number; height: number; rgba: boolean } {
  const buf = readFileSync(path);
  if (buf.length < 26 || buf.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${path} is not a valid PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), rgba: buf[25] === 6 };
}

/** Minimal CDP client over the browser-level WebSocket — every call settles. */
class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>();
  private closedErr: Error | null = null;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!.resolve(m);
        this.pending.delete(m.id);
      }
    };
    const fail = (e: Error) => {
      this.closedErr = e;
      for (const { reject } of this.pending.values()) reject(e);
      this.pending.clear();
    };
    this.ws.onclose = () => fail(new Error("CDP connection closed"));
    this.ws.onerror = () => fail(new Error("CDP connection error"));
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("CDP websocket open timed out")), CALL_TIMEOUT);
      this.ws.onopen = () => {
        clearTimeout(t);
        res();
      };
      this.ws.onerror = () => {
        clearTimeout(t);
        rej(new Error("CDP websocket failed to open"));
      };
    });
  }
  send(method: string, params?: object, sessionId?: string): Promise<any> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const id = ++this.id;
    const msg: Record<string, unknown> = { id, method, params: params ?? {} };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, CALL_TIMEOUT);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(t);
          resolve(m.result);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(t);
        reject(e as Error);
      }
    });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function readPort(udd: string, deadline: number): Promise<number> {
  const f = join(udd, "DevToolsActivePort");
  while (Date.now() < deadline) {
    if (existsSync(f)) {
      const port = Number(readFileSync(f, "utf8").split("\n")[0]?.trim());
      if (port > 0) return port;
    }
    await delay(80);
  }
  throw new Error("Chrome did not expose a DevTools port in time");
}

export async function render(svgPath: string, opts: RenderOptions = {}): Promise<RenderResult> {
  const input = resolve(svgPath);
  if (!existsSync(input)) throw new Error(`no such file: ${svgPath}`);
  const scale = opts.scale ?? 3;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`invalid --scale: ${opts.scale}`);
  const out = resolve(opts.out ?? input.replace(/\.svg$/i, "") + ".png");

  const source = readFileSync(input, "utf8");
  const info = inspect(source);
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
  const W = Math.round(w);
  const H = Math.round(h);

  const chrome = opts.chrome ?? resolveChrome();
  if (!chrome) {
    throw new Error("no Chrome/Chromium found. Install Google Chrome, or set $SVGSAFE_CHROME.");
  }

  const profile = mkdtempSync(join(tmpdir(), "svgsafe-"));
  // Chrome only ever touches $TMPDIR — copy the SVG in, render there. On macOS that
  // avoids a TCC "access your Desktop/Documents/Downloads" prompt that blocks a launch.
  const workSvg = join(profile, "input.svg");
  copyFileSync(input, workSvg);
  const logPath = join(profile, "chrome.log");
  const logFd = openSync(logPath, "w");
  const proc = spawn(chrome, [...LAUNCH_FLAGS, `--user-data-dir=${profile}`, "about:blank"], {
    stdio: ["ignore", "ignore", logFd],
  });
  let cdp: Cdp | undefined;
  const killProc = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };

  const work = (async (): Promise<RenderResult> => {
    const port = await readPort(profile, Date.now() + 20_000);
    const ver = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    cdp = new Cdp(ver.webSocketDebuggerUrl);
    await cdp.open();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: W, height: H, deviceScaleFactor: scale, mobile: false },
      sessionId,
    );
    await cdp.send(
      "Emulation.setDefaultBackgroundColorOverride",
      { color: { r: 0, g: 0, b: 0, a: 0 } },
      sessionId,
    );
    await cdp.send("Page.navigate", { url: pathToFileURL(workSvg).href }, sessionId);
    await delay(300);
    const shot = await cdp.send(
      "Page.captureScreenshot",
      { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 }, captureBeyondViewport: true },
      sessionId,
    );
    if (!shot?.data) throw new Error("Chrome returned no screenshot data");
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    const png = inspectPng(out);
    if (!png.rgba) throw new Error("output PNG is not transparent (RGBA)");
    await cdp.send("Browser.close").catch(() => {});
    return { out, width: png.width, height: png.height, chrome };
  })();

  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error(`render timed out after ${TOTAL_TIMEOUT}ms`)), TOTAL_TIMEOUT),
  );

  try {
    return await Promise.race([work, timeout]);
  } catch (err) {
    work.catch(() => {});
    let detail = (err as Error).message;
    try {
      const log = readFileSync(logPath, "utf8").trim();
      if (log) detail += "\n  chrome: " + log.split("\n").slice(-4).join("\n  chrome: ");
    } catch {
      /* no log */
    }
    throw new Error(`Chrome failed to render: ${detail}`);
  } finally {
    cdp?.close();
    killProc();
    try {
      closeSync(logFd);
    } catch {
      /* already closed */
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* OS reclaims it */
    }
  }
}
