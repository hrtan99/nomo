# Local loop budgets on official Etas 0.22.7

This dependency-free synthetic package reproduces the unresolved local `@limits` parser gap reported in [etas-frontend#97](https://github.com/etas-project/etas-frontend/issues/97).

Run `etas --no-config --cache off check .` with the official 0.22.7 CLI and its matching installed SDK. The specified annotation before `while` is rejected at `@limits` with `syntax::InvalidExpression` (exit 1).

`UPSTREAM_FOLLOWUP.md` records the exact graph and public follow-up. It does not contain application source or credentials.
