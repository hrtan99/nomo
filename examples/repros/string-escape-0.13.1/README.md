# Source escaped-backslash corruption — official 0.13.1

The checked-in package is the dependency-free positive reproduction. Run:

```sh
etas run . --allow-effects
```

Expected UTF-8 bytes for the source literal `"\\n"`: `[92, 110]`. The official pinned CLI actually prints `[92.0,10.0]` and exits 0. The JSON numeric formatting is immaterial; byte 10 should be 110.

`UPSTREAM_ISSUE.md` is the exact public payload. It contains only compiler identities, synthetic source and observed output. The Nomo compiler installation is unchanged. The larger task-draining investigation is not accepted as exact output preservation while this literal is decoded incorrectly.

Published report: [etas-frontend#84](https://github.com/etas-project/etas-frontend/issues/84).

## Official 0.13.2 acceptance

The unchanged source returns `[92.0,110.0]` with official CLI 0.13.2. The original larger task-draining source also preserves all 2,555,904 intended bytes while console input remains pending. Exact source, compiler, output and trace identities are recorded in `examples/native-project/string-escape-0132-20261112.json`. The 0.13.1 failure above remains historical evidence; no payload rewrite or compiler patch was applied. Correct shutdown of a continuously blocked reader remains a separate issue, [etas-core#65](https://github.com/etas-project/etas-core/issues/65).
