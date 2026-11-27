# Consumer type/spec edge limit, official Etas 0.24.2

Integration diagnostic: the exact 441-module Nomo review package passes `etas check --all` but native production entry preparation exceeds the internal 262,144 edge budget. This directory does not claim a standalone or minimal reproduction. The existing `tests/native_project_probe.py --scenario persist` and public source revision are documented in [UPSTREAM_ISSUE.md](UPSTREAM_ISSUE.md).

Upstream: [etas-frontend #102](https://github.com/etas-project/etas-frontend/issues/102). The local synthetic model received zero requests and the synthetic note was unchanged. Read the version-scoped [receipt](../../native-project/compiler-0242-20261127.json) for the distinct static-check and runtime acceptance scope.

The original edge-limit diagnostic is no longer observed on official 0.24.3: the unchanged source prepares the native entry and reaches its terminal and Host operations. The original failed observation remains unchanged. See the [0.24.3 receipt](../../native-project/compiler-0243-20261127.json) and [upstream follow-up](https://github.com/etas-project/etas-frontend/issues/102#issuecomment-7207154694) for the separate policy correction and runtime acceptance scope.
