# Changelog

All notable changes to svgsafe are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06

Initial release.

### Added
- **`doctor`** — diagnose the SVG-on-mobile traps that clip a card in iOS Safari /
  in-app webviews while looking perfect on desktop Chrome: missing `viewBox`,
  `<foreignObject>` sized in `%`, and fixed-width embed advice.
- **`fix`** — idempotently add a `viewBox` to the root and pin the `<foreignObject>`
  to explicit pixels; prints to stdout or writes back with `--write`.
- **`render`** — rasterize to a crisp, transparent PNG by driving an installed Chrome
  at a chosen `--scale` (device-scale-factor). Never downloads a browser.
- Zero runtime dependencies; cross-platform (macOS · Linux · Windows).
- Tests via `node:test`; CI on the full OS matrix.