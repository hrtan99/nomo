## Official 0.24.2 production-entry diagnostic

A complete source check succeeds for Nomo's exact committed package (441 Etas modules, zero diagnostics, default O2). Preparing the normal `native_project` flow for `etas run` then aborts before its first prompt or any model request:

```text
frontend session failed: Pipeline("consumer type/spec closure: checked definition projection failed: Limit { resource: \"edges\", limit: 262144 }")
```

The exact review source is public at [hrtan99/nomo, c8d07728874965e3f9e70c840e6b148b82100aea](https://github.com/hrtan99/nomo/tree/c8d07728874965e3f9e70c840e6b148b82100aea). It excludes local untracked prototypes. The existing positive production persistence scenario reproduces the preparation failure:

```sh
python3 -B tests/native_project_probe.py --scenario persist
```

That scenario uses only a new synthetic note.txt, a local synthetic HTTP model and isolated state; the preparation failure occurs before any local model request or edit. The test's Etas command is the configured native profile and `native_project` flow from etas.toml, with a synthetic project passed via `--args --workspace PATH`. The source check is `etas --no-config --cache off check --format json --all /workspace` (passes in 61.76 s under the same 4 GiB limit, no OOM).

This is an integration diagnostic, not a claimed minimal reproduction or proof that the limit is inherently wrong. Please identify a supported source contract/configuration if this graph must be reduced, or investigate excessive/repeated closure expansion. Currently the internal limit has no source position or actionable declaration/edge count. The observed `project/standard_library.rs` uses `DescriptorLimits::default()` for the consumer's type/spec substitution budget. No application flag was found for this particular budget; we have not patched the compiler or raised it locally.

Exact official graph:
- CLI e692939c4c22fab5260cfc8ffbcac4ea9e139f93 (0.24.2)
- Frontend c0c87cf3acdcfd2cfdd77d13e6bd3a905bc55fd7
- Core 44a25f003d996dd89230295f111e617c0a2a3783
- Interpreter 420c6ca133de802d1deb4fffaf755f35b988318f
- Binary SHA-256 1ff558745bee375c84bbcdda22a4ef894b22d8348edf0eb2d0dabc7612f41d78
- Matching installed SDK verified: compiler 0.21.2, body 97, metadata 78.
- Standard Cargo release, Linux/aarch64, no source overrides, compiler patches or custom Rust flags.

The original #100 six-file witness reproduction now passes on this graph; this report has a different diagnostic. A smaller conversation fixture reaches runtime but independently fails Message-to-JsonValue conversion (etas-project/etas-interpreter#119); it does not establish production composition acceptance. Payload here is public source links, exact revisions, synthetic scenario description and diagnostic metadata, with no credentials or private project content.
