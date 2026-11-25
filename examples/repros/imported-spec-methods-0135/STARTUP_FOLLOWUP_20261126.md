## Additional 0.13.5 observation: imported Console-only picker

The normal whole-project check of a new startup consumer exits 1 after checking
293 files, on the same unmodified official 0.13.5 graph reported in this issue:

```text
error[type::InvalidImplMemberKind]: bodyless impl of spec `ConversationPicker` is missing required method `choose`
 --> /workspace/src/nomo/adapters/terminal/conversation_picker.es:9:34
  | impl ConsoleConversationPicker ~ ConversationPicker {
  |                                  ^ bodyless impl of spec `ConversationPicker` is missing required method `choose`
```

Its generic application caller also reports `IncompleteEffectFacts`: method
evidence has no unique checked implementation. The implementation has a complete
method body. Unlike the command/Fs examples, this role's method has only the
explicit `Console` and `Error<ConsoleError>` row; its input is an array of imported
Session records and its result is `Option<string>`. The body renders the choices,
reads one line and returns a selected ID. The spec and impl signatures agree in
receiver, arguments, return type and explicit effects.

This is an additional **whole-consumer observation**, not an isolated reduction
or a claim that the exact trigger is known. In particular, the earlier small
Console-only control still passes; this result does not identify Console itself
as the cause. The new consumer was not executed. Its complete proposed source
and future positive acceptance remain pending; the product source and launcher
were restored byte for byte. No smaller production handler, module-order change
or compiler patch was installed.

This still reports **0.13.5 only**: CLI `826bf13bea02f1c1468e6b97b8d2ec7dad2ebc0e`,
frontend `bff83ed77b6e6bfa289117f0a96bf7c786a6b0a1`,
core `faa01c5752bfe3e46a187ee6e3def3911ab2430b`,
interpreter `3c0b78fbf147e5bb2fc33e13a501a88b97411d1c`.
No equivalent latest-graph regression is claimed: full application adoption on
the prepared 0.22.4 graph is independently blocked by scoped-loop issue #97.
The payload here is diagnostic text, public graph identities and a description
of the role shape, with no complete application source or private data.
