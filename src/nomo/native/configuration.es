module nomo.native.configuration;

import std.json.{JsonValue, parse};
import std.agent.message.Message;
import std.fs.{list, path, relative_name, IOError as FileError, ReadLimitError};
import std.effects.Fs;
import std.crypto.{sha256, constant_time_eq};
import std.codec.text.utf8_encode;
import std.io.IOError as ConsoleError;
import std.text.{from_i64, from_usize, parse_f64, parse_usize};
import nomo.native.workspace.{ProjectRoot, CommandOutput, execute_readonly_input};
import nomo.native.history.{SessionContext, NativeHistory, ConversationStore, message};
import nomo.native.file_io.read_text;

public type Settings = { context_window: i64, max_output_tokens: i64, compact_ratio: f64,
    keep_messages: i64, command_timeout: i64, ignore: Array<string>, instructions: Array<string>, check: Array<string> };
public effect SettingsContext { action current() -> Settings; }
type Entry = { key: string, value: JsonValue };
type Cached = { digest: bytes, session: string, result_event: i64 };
alias Schema = MemoryRegion<{ Parsed: Store<string, Cached> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-configuration-v1", store = "native-configuration");

public flow defaults() -> Settings {
    return Settings { context_window = 1048576, max_output_tokens = 131072, compact_ratio = 0.75,
        keep_messages = 12, command_timeout = 600, ignore = [], instructions = [], check = [] };
}

flow cast<T>(value: JsonValue, label: string) -> T {
    let result: Option<Message<T>> = Message.new(value).cast<T>();
    return match result { Some(value) => value.body, None() => { abort("project configuration has an invalid field type: " + label); } };
}

flow field<T>(values: Array<Entry>, name: string, fallback: T) -> T {
    for entry in values limit Iterations(2147483647) { if entry.key == name { return cast<T>(entry.value, name); } }
    return fallback;
}

flow decode(text: string) -> Settings {
    let root = match parse(text) { Ok(value) => cast<Array<Entry>>(value, "root entries"), Err(_) => { abort("TOML decoder returned invalid JSON"); } };
    var values = root;
    for entry in root limit Iterations(2147483647) {
        if entry.key == "project" { values = cast<Array<Entry>>(entry.value, "project entries"); break; }
    }
    let base = defaults();
    let settings = Settings { context_window = field(values, "context_window", base.context_window),
        max_output_tokens = field(values, "max_output_tokens", base.max_output_tokens),
        compact_ratio = field(values, "compact_ratio", base.compact_ratio), keep_messages = field(values, "keep_messages", base.keep_messages),
        command_timeout = field(values, "command_timeout", base.command_timeout), ignore = field(values, "ignore", base.ignore),
        instructions = field(values, "instructions", base.instructions), check = field(values, "check", base.check) };
    if settings.max_output_tokens < 1 || settings.max_output_tokens > 131072 || settings.context_window <= settings.max_output_tokens {
        abort("context_window must exceed max_output_tokens (1..131072)");
    }
    if settings.compact_ratio <= 0.0 || settings.compact_ratio >= 1.0 || settings.keep_messages < 0 {
        abort("compact_ratio must be between zero and one; keep_messages must be nonnegative");
    }
    return settings;
}

flow fingerprint(text: string) -> bytes {
    let result: Option<Message<bytes>> = Message.new(sha256(utf8_encode(text))).cast<bytes>();
    return match result { Some(value) => value.body, None() => { abort("SHA-256 representation unavailable"); } };
}

flow output(text: string) -> CommandOutput {
    return match parse(text) { Ok(value) => cast<CommandOutput>(value, "cached observation"), Err(_) => { abort("configuration observation is not JSON"); } };
}

public flow load() -> Settings
    ![SessionContext, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<ConsoleError>, Error<FileError>, Error<ReadLimitError>] {
    let root = match path<ProjectRoot>(".") { Ok(value) => value, Err(_) => { abort("project root unavailable"); } };
    var configured = false;
    for item in list(root) limit Iterations(2147483647) { if relative_name(item) == ".nomo.toml" { configured = true; } }
    if !configured { return defaults(); }
    let raw = read_text(".nomo.toml");
    let digest = fingerprint(raw);
    let session = perform SessionContext.current();
    let archive = NativeHistory {};
    let workspace = archive.load(session).workspace;
    match Data.Parsed.get(workspace) {
        Some(cached) => {
            if constant_time_eq(cached.digest, digest) { return decode(output(message(cached.session, cached.result_event).text).stdout); }
        }
        None() => {}
    }
    let observation = execute_readonly_input("project_configuration", "/home/nomo/.cargo/nomo-native-tools/taplo-0.10.0/bin/taplo",
        ["get", "-o", "json"], raw);
    if observation.output.exit_code != 0 { abort("project configuration TOML conversion failed: " + observation.output.stderr); }
    let converted = execute_readonly_input("configuration_entries", "/usr/bin/jq",
        ["-c", "walk(if type == \"object\" then to_entries else . end)"], observation.output.stdout);
    if converted.output.exit_code != 0 { abort("configuration entry conversion failed: " + converted.output.stderr); }
    let settings = decode(converted.output.stdout);
    Data.Parsed.put(workspace, Cached { digest = digest, session = session, result_event = converted.result_event });
    return settings;
}

public flow effective_window(settings: Settings) -> i64 {
    return if settings.context_window > 1048576 { 1048576 } else { settings.context_window };
}

public flow as_number(value: i64) -> f64 {
    return match parse_f64(from_i64(value)) { Ok(value) => value, Err(_) => { abort("context number conversion failed"); } };
}

public flow estimated_tokens(bytes: usize) -> f64 {
    return match parse_f64(from_usize((bytes + 2) / 3)) { Ok(value) => value, Err(_) => { abort("context estimate conversion failed"); } };
}

public flow recent_bytes(settings: Settings) -> usize {
    let available = (effective_window(settings) - settings.max_output_tokens) * 3 / 2;
    let budget = if available < 393216 { available } else { 393216 };
    return match parse_usize(from_i64(budget)) { Ok(value) => value, Err(_) => { abort("recent history budget conversion failed"); } };
}

public type ConfigurationStatus = { requested: Settings, effective_context_window: i64, context_window_is_estimate: bool,
    runtime_context_tokens: i64, runtime_output_tokens: i64, command_timeout_active: bool };
public flow status(settings: Settings) -> ConfigurationStatus {
    return ConfigurationStatus { requested = settings, effective_context_window = effective_window(settings), context_window_is_estimate = true,
        runtime_context_tokens = 1048576, runtime_output_tokens = 131072, command_timeout_active = false };
}
