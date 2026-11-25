## Version-scoped compiler diagnostic

On the official, unmodified CLI 0.13.5 dependency graph, an eight-source-file reduced adapter package produces these diagnostics although the two imported spec implementations contain method bodies:

```text
type::InvalidImplMemberKind:
bodyless impl of spec ... is missing required method ...

effect::IncompleteEffectFacts:
call effect selector specialization failed:
invalid callable environment:
method evidence has no unique checked implementation
```

Spec and implementation methods both have explicit effect rows. The consumer invokes them through generic spec constraints. The check exits 1; the stdout line `checked 8 files` is not a success. This report concerns source checking only: no application flow, command or model request was executed.

## Scope and comparison

- A simpler four-source-file imported Console spec/implementation checks successfully on 0.13.5. An imported spec by itself is therefore not a sufficient trigger.
- An equivalent eight-source-file adapter package checks successfully on official 0.22.4 after migrating the changed Command SDK APIs. This is **not** a claim that the same failure occurs on 0.22.4.
- The exact trigger and root cause remain unestablished. The expected behavior is to recognize existing implementation bodies, or issue a primary source-contract diagnostic if another declaration is invalid.
- The richer source is not included in this diagnostic-only report. No module/file ordering changes or compiler patches were applied.

## Public compiler graph identity

Official CLI 0.13.5:
- CLI: `826bf13bea02f1c1468e6b97b8d2ec7dad2ebc0e`
- Frontend: `bff83ed77b6e6bfa289117f0a96bf7c786a6b0a1`
- Core: `faa01c5752bfe3e46a187ee6e3def3911ab2430b`
- Interpreter: `3c0b78fbf147e5bb2fc33e13a501a88b97411d1c`

The passing comparison uses official CLI 0.22.4 (`8f48d3fd855b4f712e209458047ea09b4316a198`) and frontend `3825cc9d1536a0998e2fbafab1f72a58c1676d63`, with its matching installed SDK. Because the SDK changed, this comparison does not identify a particular frontend fix.

Please confirm whether the older diagnostic is a known resolved defect and point to the relevant fix if available. The separate current scoped-loop adoption blocker is already tracked in #97 and is not being reported again here.
