module nomo.adapters.storage.codec.configuration;

import std.json.{JsonValue, parse};
import std.agent.message.Message;
import std.crypto.sha256;
import std.codec.text.utf8_encode;
import nomo.domain.configuration.settings.{Settings, defaults, validate};
import nomo.domain.configuration.conversion.ConfigurationOutput;

type Entry = { key: string, value: JsonValue };

flow cast<T>(value: JsonValue, label: string) -> T {
    let result: Option<Message<T>> = Message.new(value).cast<T>();
    return match result { Some(value) => value.body, None() => abort("project configuration has an invalid field type: " + label), };
}

flow field<T>(values: Array<Entry>, name: string, fallback: T) -> T {
    for entry in values { if entry.key == name { return cast<T>(entry.value, name); } }
    return fallback;
}

public flow decode(text: string) -> Settings {
    let root = match parse(text) { Ok(value) => cast<Array<Entry>>(value, "root entries"), Err(_) => abort("TOML decoder returned invalid JSON"), };
    var values = root;
    for entry in root {
        if entry.key == "project" { values = cast<Array<Entry>>(entry.value, "project entries"); break; }
    }
    let base = defaults();
    let settings = Settings { context_window = field(values, "context_window", base.context_window),
        max_output_tokens = field(values, "max_output_tokens", base.max_output_tokens),
        compact_ratio = field(values, "compact_ratio", base.compact_ratio), keep_messages = field(values, "keep_messages", base.keep_messages),
        command_timeout = field(values, "command_timeout", base.command_timeout), ignore = field(values, "ignore", base.ignore),
        instructions = field(values, "instructions", base.instructions), check = field(values, "check", base.check) };
    return validate(settings);
}

public flow fingerprint(text: string) -> bytes {
    return sha256(utf8_encode(text));
}

public flow observation(text: string) -> ConfigurationOutput {
    return match parse(text) { Ok(value) => cast<ConfigurationOutput>(value, "cached observation"), Err(_) => abort("configuration observation is not JSON"), };
}
