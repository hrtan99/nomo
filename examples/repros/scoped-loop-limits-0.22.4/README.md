# Scoped loop limits on official Etas 0.22.4

Executed synthetic reproduction for [etas-frontend#97](https://github.com/etas-project/etas-frontend/issues/97). The matching design specification requires the prefix annotation used in `src/app/main.es`, but `check --all` rejects it at `@limits` with `syntax::InvalidExpression`.

With the official 0.22.4 compiler and matching installed SDK:

```sh
etas --no-config --cache off pkg lock .
etas --no-config --cache off check --all .
```

Lock succeeds; check exits 1. `result.json` records the actual diagnostic and identities. `UPSTREAM_ISSUE.md` contains the exact public report. There are no model requests or external actions. This case does not certify runtime iteration enforcement; it cannot reach execution.
