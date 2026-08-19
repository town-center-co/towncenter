# Working on this repository with an AI assistant

The conventions file is [`ARCHITECTURE.md`](ARCHITECTURE.md). Read it before
changing code: most of what it documents is invisible to `tsc` and to
`next build`.

Then [`CONTRIBUTING.md`](CONTRIBUTING.md) for the benches and the pull request
rules.

## Comments

One line maximum, and only when the code cannot say it itself. No paragraph, no
block of explanation: if a rule needs more than a line, it belongs in
`ARCHITECTURE.md`. This applies to new comments; the existing multi-line blocks
are left alone until the code around them is rewritten.

## Two things that only matter to an automated agent

- Never run `npm run dev` as a blocking command.
- `npm run typecheck` runs `next typegen`, which writes to `.next/`. Use
  `npx tsc --noEmit` when a read-only check is enough.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
