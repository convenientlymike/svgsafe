import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "../src/svg.js";
import { doctor } from "../src/doctor.js";
import { fix } from "../src/fix.js";
import { render } from "../src/render.js";
import { resolveChrome } from "../src/chrome.js";

// A foreignObject card with the two iOS/WebKit traps: no viewBox + 100% sizing.
const BAD = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="442" class="">
  <foreignObject x="0" y="0" width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml">card</div>
  </foreignObject>
</svg>`;

// A plain icon: scalable (has viewBox), no foreignObject.
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path d="M1 1h14v14H1z"/></svg>`;

test("inspect reads root + foreignObject", () => {
  const i = inspect(BAD);
  assert.equal(i.width, 480);
  assert.equal(i.height, 442);
  assert.equal(i.hasViewBox, false);
  assert.ok(i.foreignObject);
  assert.equal(i.foWidth, "100%");
});

test("doctor flags no-viewbox and foreignobject-percent as errors", () => {
  const r = doctor(BAD);
  const codes = r.findings.map((f) => f.code);
  assert.ok(codes.includes("no-viewbox"));
  assert.ok(codes.includes("foreignobject-percent"));
  assert.equal(r.ok, false);
});

test("doctor passes a clean icon (no error-level findings)", () => {
  const r = doctor(ICON);
  assert.equal(r.ok, true);
  assert.equal(r.findings.filter((f) => f.severity === "error").length, 0);
});

test("fix adds viewBox + pins foreignObject", () => {
  const r = fix(BAD);
  assert.equal(r.changed, true);
  assert.match(r.source, /<svg[^>]*viewBox="0 0 480 442"/);
  assert.match(r.source, /<foreignObject[^>]*width="480"/);
  assert.match(r.source, /<foreignObject[^>]*height="442"/);
  assert.doesNotMatch(r.source, /<foreignObject[^>]*100%/);
  assert.ok(r.applied.length >= 2);
});

test("fix makes doctor pass", () => {
  const fixed = fix(BAD).source;
  assert.equal(doctor(fixed).ok, true);
});

test("fix is idempotent", () => {
  const once = fix(BAD).source;
  const twice = fix(once);
  assert.equal(twice.changed, false);
  assert.equal(twice.source, once);
});

test("fix leaves a clean icon untouched", () => {
  assert.equal(fix(ICON).changed, false);
});

// The CDP renderer (explicit Browser.close, no --screenshot CLI) is version-proof,
// so it runs on every OS where a Chrome exists — including macOS CI.
const renderSkip = resolveChrome() ? false : "no Chrome/Chromium found";

test("render produces a transparent PNG", { skip: renderSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "svgsafe-test-"));
  try {
    const svg = join(dir, "in.svg");
    writeFileSync(
      svg,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30" width="40" height="30"><rect width="40" height="30" rx="6" fill="#22d3ee"/></svg>`,
    );
    const r = await render(svg, { scale: 2 });
    assert.equal(r.width, 80); // 40 * scale 2
    assert.equal(r.height, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});