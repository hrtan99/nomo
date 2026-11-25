module nomo.native.configuration;

import std.fs.{list, path, relative_name, IOError as FileError, ReadLimitError};
import std.effects.Fs;
import std.crypto.constant_time_eq;
import std.io.IOError as ConsoleError;
public import nomo.domain.configuration.settings.{Settings, defaults, effective_window, as_number, estimated_tokens, recent_bytes};
import nomo.adapters.codec.configuration.{decode, fingerprint, observation as output};
import nomo.native.workspace.{ProjectRoot, execute_readonly_input};
import nomo.native.history.{SessionContext};
import nomo.adapters.etas.conversations.{NativeHistory, read_message as message};
import nomo.application.native.conversation.ports.{ConversationReader};
import nomo.native.file_io.read_text;

public import nomo.application.native.configuration.context.SettingsContext;
type Cached = { digest: bytes, session: string, result_event: i64 };
alias Schema = MemoryRegion<{ Parsed: Store<string, Cached> }>;
let Data = std.memory.region<Schema>(stable_id = "nomo-native-configuration-v1", store = "native-configuration");

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

public type ConfigurationStatus = { requested: Settings, effective_context_window: i64, context_window_is_estimate: bool,
    inference_token_allowance: i64, summary_token_allowance: i64, runtime_output_tokens: i64, command_timeout_active: bool };
public flow status(settings: Settings) -> ConfigurationStatus {
    return ConfigurationStatus { requested = settings, effective_context_window = effective_window(settings), context_window_is_estimate = true,
        inference_token_allowance = 536870912, summary_token_allowance = 1048576, runtime_output_tokens = 131072, command_timeout_active = false };
}
