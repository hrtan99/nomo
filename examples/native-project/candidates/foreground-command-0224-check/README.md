# Isolated command adapter compilation on official 0.22.4

This is the exact eight-source-file snapshot accepted by the matching installed SDK with:

```sh
etas --no-config --cache off check --all .
```

It checks the command request/result records, interface implementations, console preview and generic invocation. The SDK's current constructor is `Command.new(program, args)`; cwd and stdin use instance methods. The Host implementation explicitly declares its high-impact effect contract.

This package was checked, not run. It does not establish command execution, approval, journal recovery or complete Nomo compatibility. The full proposed integration is in `../foreground-command-dip08-0224.patch`; evidence and remaining gates are in its adjacent JSON. Product source remains on the accepted 0.13.5 workflow while the target graph lacks the required scoped-loop syntax.
