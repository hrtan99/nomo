# Generic capture-port check on official 0.24.3

The synthetic module checks parameterized effect admission and a spec-backed reader captured by Task. Ordinary check exits 1 with the retained `IncompleteEffectFacts`, `EffectOutsideDeclaredRow` and `EscapedEffect` diagnostics. The two observations are not assumed to share a cause. Runtime was not executed. See `result.json` and `UPSTREAM_ISSUE.md` for exact source, command, official graph and scope.

Upstream report: https://github.com/etas-project/etas-frontend/issues/103.
