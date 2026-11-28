# Explicit native 0.24.13 state relocation

These are one-time migration entries, outside `nomo.main` and `src/nomo`.
`old/src` freezes the original passive declarations required by 43 stores.
It contains no old application loop, model, command or editor implementation.
The three historical resource assemblies under `app/old_*` keep the original
stable region IDs and store paths; stored nominal declarations retain their
original defining modules and representation.

`export.es` reads an owned SQLite backup with the original official codecs,
converts each value directly with checked `Message.cast<New>()`, then encodes
with the official destination codec. Source and target use package `nomo` version
`0.1.0`, because package identity participates in stored type identity. Direct
conversion avoids passing counters through `JsonValue.Number(f64)`.

The host adapter retains each encoded payload as an unchanged `.ets` binary
file. The JSON manifest contains only row names, keys and file references.
`import.es` invokes the current application migration flow and normal Memory
inserts into a separate destination. The old source database, receipts and
filesystem snapshots are retained; historical binding/version strings stay
historical. No approval, process, command or recovery action is replayed.
The optional v4 stores are assembled here without adding them to `nomo.main`.

Use `scripts/nomo-migrate-native --from native-02413 SOURCE NEW_DIRECTORY`.
The directory must be new. The command never selects or publishes the new state;
select its `state/` only after the migration report says `completed`. Stop the
old Nomo and its background writers before taking the source snapshot.

`seed.es` is a synthetic producer used only by `tests/state_relocation_probe.py`.
It fills all 43 stores, including nested records, Unicode/raw bytes, historical
binding/version observations and i64 values above JSON's exact integer range.
`stores.json` is the explicit source/destination ownership inventory; it is not
a replacement runtime compatibility manifest.
