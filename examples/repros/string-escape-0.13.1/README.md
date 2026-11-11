# Source escaped-backslash corruption — official 0.13.1

The checked-in package is the dependency-free positive reproduction. Run:

```sh
etas run . --allow-effects
```

Expected UTF-8 bytes for the source literal `"\\n"`: `[92, 110]`. The official pinned CLI actually prints `[92.0,10.0]` and exits 0. The JSON numeric formatting is immaterial; byte 10 should be 110.

`UPSTREAM_ISSUE.md` is the exact public payload. It contains only compiler identities, synthetic source and observed output. The Nomo compiler installation is unchanged. The larger task-draining investigation is not accepted as exact output preservation while this literal is decoded incorrectly.

Published report: [etas-frontend#84](https://github.com/etas-project/etas-frontend/issues/84).
