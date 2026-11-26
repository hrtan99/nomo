## Observed failure

An ordinary full consumer check on the unmodified official CLI 0.23.0 aborts with exit 4:

```text
frontend session failed: Pipeline("checked definition projection failed: Invalid(\"checked effect tag has conflicting package identities\")")
```

Command: `etas --no-config --cache off check <project>`.

The message provides no source location, effect tag, existing identity or incoming identity. It prevents determining whether a remaining source issue, an imported SDK identity, or projection itself triggered the invariant. I have **not isolated a minimal source reproduction**, and am not claiming that all consumer source is already valid.

The actual consumer was checked without dropping files or changing source order. A separate import/dependency audit resolves all named imports and rejects cycles. The same internal failure was observed before and after its application/adapter directory refactor. Small synthetic examples with Memory/Console, two namespaced effects, custom action-level rows and the actual SDK capability-row shape check successfully; they are not reproductions of this failure.

## Requested diagnostic

Please include the effect tag and both conflicting `DefinitionKey` values in this error, with their resolved names/source origins when available. The pinned frontend has the conflict check in `bind_effect` in `crates/etas_frontend/src/code/identity/mod.rs`, but it returns only the constant message above. Preserving any preceding ordinary diagnostics would also help locate an invalid source construct instead of obscuring it with the projection failure.

This request does not propose bypassing the identity check.

## Official graph and SDK

- CLI 0.23.0: `f904fa0da460262aab4a3ed490d1704c1dd526a7`
- Core/std: `19a2b142edc2f61b97c27d8bd3270d0cc35bcc50`
- Frontend: `61f17bcd20704e55df7d723968bb836275d57908`
- Interpreter: `fb7a8bc03109b2c8c20f73780025b8f05f2a9a86`
- Official Cargo.lock SHA-256: `6be90cb08562d26025aedb85e75e363db39eb6acb1a9d62fdf223e4115064a38`
- CLI binary SHA-256: `88450cfd52d011ec3f3ed943b3df9b986e32513b6cd818090733e4339c911f10`
- Matching SDK installed by official `etas std install --prefix`.
- SDK manifest SHA-256: `e6027bbe8db7233b0ee4ccd8b65fe3c23ce38233c965d175b6f5871302f8e1bf`
- SDK compiler 0.20.0, metadata schema 77, body schema 93.
- Linux/aarch64; standard Cargo dev profile/default features; source, tree, lockfile, registry and SDK receipt checks pass. No compiler patches or dependency source overrides.

No credentials, model request, private file contents or full consumer source are included in this report.
