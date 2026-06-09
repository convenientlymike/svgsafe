#!/usr/bin/env node
/**
 * svgsafe — make SVGs render everywhere.
 *
 *   svgsafe doctor <file.svg>            diagnose iOS/WebKit clipping traps
 *   svgsafe fix    <file.svg> [-w]       add viewBox + pin foreignObject
 *   svgsafe render <file.svg> [opts]     rasterize to a crisp transparent PNG
 */
import { readFileSync, writeFileSync } from "node:fs";
import { doctor, type Severity } from "./doctor.js";
import { fix } from "./fix.js";
import { render } from "./render.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const useColor = process.stdout.isTTY && process.env.NO_COLOR == null;
const paint = (s: string, ...codes: string[]) =>
  useColor ? codes.join("") + s + C.reset : s;

const VERSION = "0.1.0";

function usage(): void {
  process.stdout.write(`${paint("svgsafe", C.bold, C.cyan)} — make SVGs render everywhere

${paint("USAGE", C.bold)}
  svgsafe doctor <file.svg>              diagnose iOS/WebKit clipping traps
  svgsafe fix    <file.svg> [--write]    add viewBox + pin foreignObject (idempotent)
  svgsafe render <file.svg> [options]    rasterize to a crisp transparent PNG

${paint("FIX OPTIONS", C.bold)}
  -w, --write          write changes back to the file (default: print to stdout)

${paint("RENDER OPTIONS", C.bold)}
  -s, --scale <n>      device-scale-factor (default: 3 — crisp on Retina)
  -o, --out <file>     output path (default: <input>.png)
      --chrome <path>  explicit Chrome/Chromium binary

${paint("GLOBAL", C.bold)}
  -h, --help           show this help
  -v, --version        print version

svgsafe never downloads a browser; render drives an installed Chrome
(override with $SVGSAFE_CHROME). ${paint("https://github.com/convenientlymike/svgsafe", C.dim)}
`);
}

interface ParsedArgs {
  file?: string;
  write: boolean;
  scale?: number;
  out?: string;
  chrome?: string;
}

function parse(args: string[]): ParsedArgs {
  const p: ParsedArgs = { write: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-w":
      case "--write":
        p.write = true;
        break;
      case "-s":
      case "--scale":
        p.scale = Number(args[++i]);
        break;
      case "-o":
      case "--out":
        p.out = args[++i];
        break;
      case "--chrome":
        p.chrome = args[++i];
        break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
        if (p.file == null) p.file = a;
        else throw new Error(`unexpected argument: ${a}`);
    }
  }
  return p;
}

const SEV_STYLE: Record<Severity, [string, string]> = {
  error: ["✘", C.red],
  warn: ["▲", C.yellow],
  info: ["ℹ", C.cyan],
};

function cmdDoctor(file: string): number {
  const src = readFileSync(file, "utf8");
  const { findings, ok } = doctor(src);
  const errs = findings.filter((f) => f.severity === "error").length;
  const warns = findings.filter((f) => f.severity === "warn").length;

  process.stdout.write(`${paint("svgsafe doctor", C.bold)} ${paint(file, C.dim)}\n\n`);
  for (const f of findings) {
    const [icon, color] = SEV_STYLE[f.severity];
    process.stdout.write(`${paint(icon, color)} ${paint(f.code, C.bold)}  ${f.message}\n`);
    process.stdout.write(`  ${paint("→ " + f.fix, C.dim)}\n\n`);
  }
  const summary = ok
    ? paint("✓ no blocking issues", C.green)
    : paint(`✘ ${errs} error${errs === 1 ? "" : "s"}`, C.red);
  process.stdout.write(`${summary}${warns ? paint(`  ·  ${warns} warning(s)`, C.yellow) : ""}\n`);
  return ok ? 0 : 1;
}

function cmdFix(file: string, write: boolean): number {
  const src = readFileSync(file, "utf8");
  const res = fix(src);
  if (write) {
    if (res.changed) {
      writeFileSync(file, res.source);
      for (const a of res.applied) process.stdout.write(`${paint("✓", C.green)} ${a}\n`);
      process.stderr.write(paint(`wrote ${file}\n`, C.dim));
    } else {
      process.stderr.write(paint("already safe; no changes\n", C.dim));
    }
    return 0;
  }
  // default: emit the fixed SVG to stdout (pipe-friendly), notes to stderr
  for (const a of res.applied) process.stderr.write(`${paint("✓", C.green)} ${a}\n`);
  if (!res.changed) process.stderr.write(paint("already safe; no changes\n", C.dim));
  process.stdout.write(res.source);
  return 0;
}

async function cmdRender(file: string, p: ParsedArgs): Promise<number> {
  const r = await render(file, { scale: p.scale, out: p.out, chrome: p.chrome });
  process.stdout.write(
    `${paint("✓", C.green)} ${paint(r.out, C.bold)}  ${r.width}×${r.height} transparent PNG\n` +
      paint(`  via ${r.chrome}\n`, C.dim),
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd == null || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return 0;
  }
  if (cmd === "-v" || cmd === "--version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const p = parse(rest);
  if (!["doctor", "fix", "render"].includes(cmd)) {
    process.stderr.write(paint(`unknown command: ${cmd}\n\n`, C.red));
    usage();
    return 2;
  }
  if (!p.file) {
    process.stderr.write(paint(`error: ${cmd} needs a <file.svg>\n`, C.red));
    return 2;
  }
  if (cmd === "doctor") return cmdDoctor(p.file);
  if (cmd === "fix") return cmdFix(p.file, p.write);
  return cmdRender(p.file, p);
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(paint(`error: ${(err as Error).message}\n`, C.red));
    process.exit(1);
  });