# Character slice continuation hang

Confirmed on official ETAS 0.12.0 on 2026-11-11. Run this dependency-free package with:

```sh
timeout --signal=INT --kill-after=2s 30s etas run . --allow-effects
```

Expected output includes `SLICE_BYTES 70001`. Observed: `SLICE_START`, then a hang until the external deadline (exit 124). The full compiler identity, synthetic source and suspected continuation error are in `UPSTREAM_ISSUE.md`.

This blocks acceptance of native large-message history chunking and automatic context compaction. It is not worked around in Nomo.

Upstream report: https://github.com/etas-project/etas-interpreter/issues/101.
