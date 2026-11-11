## Observed on the official 0.13.1 graph

- CLI `1e7877edad58f8a7dec92c0b9630cd19f6365020`
- frontend `b09ceec7f57d1791dc92d358150cfc8c87935771`
- core `cdb49367e73aadba56fbc89c984668ee3c1dd0aa`
- interpreter `9a63968fea9bdf958db79d70a6723b992154533d`
- CLI binary SHA-256 `9da7f127230b4b56233ba7fb350436d6d1021b4702b1e4a38d6eabb5c34a985e`
- Linux/aarch64 in an unprivileged Docker container. Official CLI Cargo.lock; no source overrides or local compiler patches.

The CLI and frontend `main` heads still match these revisions when filing this report. Issue searches for `backslash escape` and `unquote_string` returned no matches.

## Standalone source

`etas.toml`:
```toml
[package]
name = "string-escape"
version = "0.1.0"
edition = "2026"
[source]
root = "src"
[runtime]
default_profile = "local"
[runtime.profiles.local.policy]
mode = "local-static"
rules = ["console=allow"]
[[bin]]
name = "string-escape"
module = "app.main"
flow = "main"
```

`src/app/main.es`:
```etas
module app.main;
import std.agent.message.Message;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.io.println;

flow main(args: Array<string>) -> i32 ![Console, Error<IOError>] {
    let original = "\\n";
    let projected: Option<Message<JsonValue>> = Message.new(utf8_encode(original)).cast<JsonValue>();
    let value = match projected { Some(value) => value.body, None() => { abort("byte projection unavailable"); } };
    println(match stringify(value) { Ok(text) => text, Err(_) => { abort("byte encoding unavailable"); } });
    return 0;
}
```

Run `etas pkg lock .`, then `etas run . --allow-effects`.

## Expected and actual

The literal contains an escaped backslash followed by ordinary `n`. Its UTF-8 bytes should be `[92, 110]`.

The valid program exits **0**, with empty stderr, and prints:
```text
[92.0,10.0]
```

The second byte is LF, not `n`. No model, command, network or application storage service participates in this reduced reproduction; this is a source-literal observation, not a claim that runtime JSON decoding is broken.

This also corrupts embedded source text: a Python string escape intended to remain backslash plus `n` becomes backslash plus an actual newline; Python then treats it as line continuation. We first observed a synthetic output payload missing exactly its intended newlines. The reduced example above needs no Python or subprocess.

## Source inspection

The pinned frontend's [`unquote_string`](https://github.com/etas-project/etas-frontend/blob/b09ceec7f57d1791dc92d358150cfc8c87935771/crates/etas_syntax/src/grammar/expr.rs#L960) applies global replacements for quote/newline/carriage-return/tab sequences. It does not consume escaped backslashes before considering the following character. Thus the second backslash of the source sequence is treated as the beginning of a newline escape. This mechanism is inferred from the source; the valid program and observed bytes above were directly executed.

Please decode escape sequences left-to-right so an escaped backslash is consumed once and the following `n` remains literal. The source must produce `[92, 110]` without a consumer rewrite or compiler patch. This report contains only official versions, synthetic standalone source and its output; no real project contents or credentials.
