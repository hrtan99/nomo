module app.main;

import std.io.{println, IOError};
import std.effects.Fs;
import nomo.application.commands.effects.CommandOperations;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.application.context.ports.InstructionReader;
import nomo.domain.serialization.json.encode;
import nomo.adapters.storage.conversations.NativeHistory;
import nomo.application.conversation.ports.{ConversationCatalog, ConversationReader, ConversationWriter};
import nomo.application.configuration.ports.{ConfigurationFile, TomlConverter, ConfigurationCacheStore};
import nomo.application.configuration.service.ConfigurationLoader;
import nomo.adapters.filesystem.configuration.codec.JsonConfigurationCodec;
import nomo.adapters.filesystem.instructions.ProjectInstructionFiles;
import nomo.application.instructions.ports.InstructionFiles;
import nomo.application.instructions.service.load as load_guidance;
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

type FixtureSource = {};
impl FixtureSource ~ ConfigurationFile {
    flow read(self) -> Option<string> { return Some("keep_messages = 2\n"); }
}

type FixtureConversion = { history: NativeHistory };
impl FixtureConversion ~ TomlConverter {
    flow toml(self, session: string, raw: string) -> Converted ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] {
        if raw != "keep_messages = 2\n" { abort("converter lost exact raw configuration"); }
        println("PORT toml");
        return observed(self.history, session, "project_configuration", "{\"keep_messages\":2}");
    }
    flow entries(self, session: string, json: string) -> Converted ![Memory, Console, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<BudgetExceeded>] {
        if json != "{\"keep_messages\":2}" { abort("entry conversion input changed"); }
        println("PORT entries");
        return observed(self.history, session, "configuration_entries", "[{\"key\":\"keep_messages\",\"value\":2}]");
    }
}

type FixtureCache = { session: string };
impl FixtureCache ~ ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<CacheReference> {
        if workspace != "configuration-workspace" { abort("cache workspace changed"); }
        return Cache.Entries.get(workspace);
    }
    flow remember(self, workspace: string, value: CacheReference) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>] {
        if value.session != self.session || value.result_event != 1 { abort("cache result linkage changed"); }
        Cache.Entries.put(workspace, value);
    }
}

flow configured(history: NativeHistory, session: string) -> Settings {
    let loader = ConfigurationLoader<NativeHistory, FixtureSource, JsonConfigurationCodec, FixtureConversion, FixtureCache> {
        history, source = FixtureSource {}, codec = JsonConfigurationCodec {},
        converter = FixtureConversion { history }, cache = FixtureCache { session },
    };
    return loader.load(session);
}

public flow main(args: Array<string>) -> i32 ![CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>, Error<IndexError>, Error<BudgetExceeded>] {
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
    let guidance = (ProjectInstructionFiles {}).read("src/future/new.py");
    if guidance != [ProjectInstruction { scope = ".", path = "AGENTS.md", text = "Root guidance" },
                    ProjectInstruction { scope = "src", path = "src/AGENTS.md", text = "Scoped guidance" }] {
        abort("physical root-to-leaf guidance changed");
    }
    println("PASS physical project guidance");
    return 0;
}
