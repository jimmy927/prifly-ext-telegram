---
setup:
  - "test ! -f package.json || bun install --frozen-lockfile"
---

A bun project made from prifly's extension template (`templates/prifly-ext-template`).
The install is skipped while the repository has no `package.json` yet (its first commit
was empty).

Relies on outside the worktree: `bun` on PATH, and the GitHub ssh key that fetches
`@prifly/extension-api` from its private mirror (`github:jimmy927/prifly-extension-api`,
pinned by tag in `package.json`). Tests run with `bun test` over fakes; no network.
