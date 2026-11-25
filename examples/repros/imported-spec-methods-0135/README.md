# Imported spec implementation diagnostic (official 0.13.5)

`project/` is the exact retained eight-source-file reduced package with explicit implementation effect rows. Its prior executed check exits 1; see `retained-0135.json`. No application flow or native command was executed. All command data is synthetic.

The equivalent matching-SDK 0.22.4 package passed its prior executed check, recorded in `comparison-0224.json`; its complete source snapshot is `../../native-project/candidates/foreground-command-0224-check/`. This is a version-scoped report, not a claim of a new 0.22.4 regression or a confirmed root cause.

`simple-control/` is the independently checked four-source-file Console example, which passes on 0.13.5 (`0135-check.json`). It is retained because it limits the failure claim: a plain imported spec is insufficient to reproduce the richer case. No counterexample matrix was run.

The published diagnostic-only report is [frontend #98](https://github.com/etas-project/etas-frontend/issues/98), with exact submitted text in `UPSTREAM_ISSUE_SUMMARY.md`. The full-source draft was rejected by automatic approval and was not published; it remains only in local ignored evidence. Source hashes are in `source-sha256.json`. No module reordering or compiler patch is used.
