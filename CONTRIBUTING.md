# Contributing to svgsafe

Thanks for helping make SVGs render everywhere.

## Ground rules
- **Zero runtime dependencies.** The whole value is "drop-in, no supply chain."
  Dev dependencies (TypeScript, tsx) are fine; runtime deps are not.
- **Cross-platform.** Code must run on macOS, Linux, and Windows. Use
  `node:path` / `node:os` for paths and temp dirs — never hardcode `/tmp`, `~`,
  or `\`. Don't shell out to Unix-only tools. CI runs the full matrix.
- **`render` drives an installed Chrome** — it must never download a browser.

## Workflow
```bash
pnpm install
pnpm typecheck      # tsc --noEmit
pnpm build          # tsc -> dist/
pnpm test           # node:test (render tests skip if no Chrome is installed)
pnpm dev -- doctor examples/card.svg   # run the CLI from source via tsx
```

1. Branch from `main`.
2. Make the change; keep `pnpm typecheck && pnpm build && pnpm test` green.
3. Conventional-commit message (`feat:`, `fix:`, `docs:`, `chore:`) explaining the *why*.
4. Open a PR; the cross-OS CI matrix must be green.

## Adding a `doctor` check
Add the finding in `src/doctor.ts` (with a clear `code`, `message`, and actionable
`fix`), and — if it's auto-repairable — the matching transform in `src/fix.ts`. Cover
both with a test in `test/`.