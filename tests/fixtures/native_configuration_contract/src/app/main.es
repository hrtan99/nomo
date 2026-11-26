module app.main;

import nomo.bootstrap.instructions;
import std.io.{println, IOError};
import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.adapters.filesystem.instruction_tools.load_instructions;
import nomo.domain.serialization.json.encode;
import nomo.application.conversation.session_context.SessionContext;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.application.conversation.ports.{ConversationCatalog, ConversationReader, ConversationWriter};
import nomo.application.configuration.ports.{ConfigurationSource, ConfigurationCodec, ConfigurationConversion, ConfigurationCache};
import nomo.application.configuration.service.load as load_settings;
import nomo.application.instructions.ports.InstructionFiles;
import nomo.application.instructions.service.load as load_guidance;
import nomo.adapters.storage.codec.configuration.{decode, fingerprint, observation};
import nomo.domain.configuration.conversion.{ConfigurationOutput, Converted, CacheReference};
import nomo.domain.configuration.settings.Settings;
import nomo.domain.context.instructions.ProjectInstruction;

alias Schema = MemoryRegion<{ Entries: Store<string, CacheReference> }>;
let Cache = std.memory.region<Schema>(stable_id = "nomo-configuration-contract-fixture-v1", store = "configuration-fixture");

flow observed(history: NativeHistory, session: string, name: string, text: string) -> Converted {
    let output = ConfigurationOutput { exit_code = 0, stdout = text, stderr = "" };
    let json = match encode(output, "fixture conversion failed", "fixture encoding failed") { Ok(value) => value, Err(error) => abort(error), };
    let event = history.append(session, "observation", name, json, -1);
    return Converted { result_event = event, output = output };
}

flow configured(history: NativeHistory, session: string) -> Settings {
    return load_settings(history) with {
        ConfigurationSource.read() => { println("PORT source"); Some("keep_messages = 2\n") }
        ConfigurationCodec.fingerprint(raw) => fingerprint(raw);
        ConfigurationCodec.decode_json(text) => decode(text);
        ConfigurationCodec.observation(text) => observation(text);
        SessionContext.current() => { println("PORT session"); session }
        ConfigurationCache.lookup(workspace) => {
            if workspace != "configuration-workspace" { abort("cache workspace changed"); }
            println("PORT lookup");
            Cache.Entries.get(workspace)
        }
        ConfigurationCache.remember(workspace, value) => {
            if value.session != session || value.result_event != 1 { abort("cache result linkage changed"); }
            Cache.Entries.put(workspace, value);
            println("PORT remember");
            ()
        }
        ConfigurationConversion.toml(raw) => {
            if raw != "keep_messages = 2\n" { abort("converter lost exact raw configuration"); }
            println("PORT toml");
            observed(history, session, "project_configuration", "{\"keep_messages\":2}")
        }
        ConfigurationConversion.entries(json) => {
            if json != "{\"keep_messages\":2}" { abort("entry conversion input changed"); }
            println("PORT entries");
            observed(history, session, "configuration_entries", "[{\"key\":\"keep_messages\",\"value\":2}]")
        }
    };
}

public flow main(args: Array<string>) -> i32 ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>] {
    let history = NativeHistory {};
    let session = history.create("configuration-workspace", "Configuration contract");
    let first = configured(history, session.id);
    let second = configured(history, session.id);
    if first != second || first.keep_messages != 2 || first.context_window != 1048576 || first.command_timeout != 600 || first.check.len() != 0 {
        abort("configuration decode or defaults changed");
    }
    if history.load(session.id).next_event != 2 { abort("cache hit repeated conversion or lost saved observations"); }
    let guidance = load_guidance("src/future/new.py") with {
        InstructionFiles.normalize(path) => {
            if path != "src/future/new.py" { abort("instruction input changed"); }
            resume path;
        }
        InstructionFiles.entries(scope) => {
            println("PORT scope " + scope);
            if scope == "." { ["AGENTS.md", "src"] } else { ["src/AGENTS.md"] }
        }
        InstructionFiles.text(path) => {
            println("PORT guidance " + path);
            if path == "AGENTS.md" { "Root guidance" } else { "Scoped guidance" }
        }
    };
    if guidance != [ProjectInstruction { scope = ".", path = "AGENTS.md", text = "Root guidance" },
                    ProjectInstruction { scope = "src", path = "src/AGENTS.md", text = "Scoped guidance" }] {
        abort("root-to-leaf guidance for the proposed file changed");
    }
    println("PASS configuration cache and instruction application effects");
    return 0;
}

public flow physical_guidance(args: Array<string>) -> i32 ![Console, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>, Error<IOError>] {
    let guidance = handle load_instructions("src/future/new.py") with instructions.bindings();
    if guidance != [ProjectInstruction { scope = ".", path = "AGENTS.md", text = "Root guidance" },
                    ProjectInstruction { scope = "src", path = "src/AGENTS.md", text = "Scoped guidance" }] {
        abort("physical root-to-leaf guidance changed");
    }
    println("PASS physical project guidance");
    return 0;
}
