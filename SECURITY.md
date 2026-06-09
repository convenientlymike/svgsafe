# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's **"Report a vulnerability"**
(Security → Advisories) on this repository, or by opening a minimal issue that
omits exploit details and asks for a private channel.

## Scope & threat model

svgsafe is a local CLI with **zero runtime dependencies**. It:

- reads an SVG file you point it at and writes an SVG/PNG you ask for;
- for `render`, spawns an **already-installed** Chrome/Chromium in headless
  screenshot mode (it never downloads or bundles a browser);
- makes **no network calls** and collects **no telemetry**.

Notes:

- `render` passes a `file://` URL of your SVG to Chrome. SVGs can reference
  external resources; render in a trusted directory and review untrusted SVGs
  with `doctor` first.
- Override the browser binary with `$SVGSAFE_CHROME` if you want to pin exactly
  which Chrome is used.