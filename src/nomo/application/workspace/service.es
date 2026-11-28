module nomo.application.workspace.service;

import nomo.application.conversation.ports.{ConversationConfiguration, ConversationReader, ConversationWriter};
import nomo.application.execution.commands.execute_readonly;
import nomo.application.execution.ports.CommandOperations;
import nomo.application.resources.{LaunchRoot, ProjectRoot};
import nomo.application.scope.{SessionContext, SettingsContext};
import nomo.application.workspace.ports.{
    ConfigurationCacheStore,
    ConfigurationFile,
    EntriesCodec,
    InstructionFiles,
    InstructionReader,
    ProjectDisplay,
    ProjectFileSource,
    ProjectLaunchControl,
    ProjectOperations,
    ProjectRenderer,
    RecentProjects,
    TomlConverter,
    WorkspaceObservations
};
import nomo.domain.commands.CommandOutput;
import nomo.domain.settings.{CachedConfiguration, Settings, defaults};
import nomo.domain.wire.encode;
import nomo.domain.workspace.{
    FileContent,
    LaunchRequest,
    MatchLine,
    PathInfo,
    ProjectInstruction,
    ProjectReference,
    SearchRequest,
    child_scopes,
    guide_path,
    reference,
    remembered,
    saved
};
import std.crypto.constant_time_eq;
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError, WorkspacePath, path as fs_path, relative_name};
import std.io.IOError;
import std.text.{contains, from_i32, lines, trim};

public type ConfigurationLoader<
    History ~ ConversationReader,
    Source ~ ConfigurationFile,
    Codec ~ EntriesCodec,
    Converter ~ TomlConverter,
    Cache ~ ConfigurationCacheStore
> = {
    @inject history: History,
    @inject source: Source,
    @inject codec: Codec,
    @inject converter: Converter,
    @inject cache: Cache,
};

impl ConfigurationLoader<
    History ~ ConversationReader,
    Source ~ ConfigurationFile,
    Codec ~ EntriesCodec,
    Converter ~ TomlConverter,
    Cache ~ ConfigurationCacheStore
> ~ ConversationConfiguration {
    flow load(self, session: string) -> Settings
    ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<fs_IOError>,
        Error<ReadLimitError>,
        Error<BudgetExceeded>
    ] {
        let raw = match self.source.read() {
            Some(value) => value,
            None() => {
                return defaults();
            }
        };
        let digest = self.codec.fingerprint(raw);
        let workspace = self.history.load(session).workspace;
        match self.cache.lookup(workspace) {
            Some(cached) => {
                if constant_time_eq(cached.digest, digest) {
                    let observation = self.codec.observation(
                        self.history.message(cached.session, cached.result_event).text
                    );
                    return self.codec.decode_json(observation.stdout);
                }
            },
            None() => (),
        }
        let observation = self.converter.toml(session, raw);
        if observation.output.exit_code != 0 {
            abort("project configuration TOML conversion failed: " + observation.output.stderr);
        }
        let converted = self.converter.entries(session, observation.output.stdout);
        if converted.output.exit_code != 0 {
            abort("configuration entry conversion failed: " + converted.output.stderr);
        }
        let settings = self.codec.decode_json(converted.output.stdout);
        self.cache.remember(
            workspace,
            CachedConfiguration {
                digest,
                session,
                result_event = converted.result_event
            }
        );
        return settings;
    }
}

flow guide(scope: string) -> Option<ProjectInstruction> {
    let name = guide_path(scope);
    let entries = perform InstructionFiles.entries(scope);
    if entries.iter().any(item => item == name) {
        return Some(ProjectInstruction {
            scope,
            path = name,
            text = perform InstructionFiles.text(name)
        });
    }
    return None();
}

public flow load(pathname: string) -> Array<ProjectInstruction> {
    let normalized = perform InstructionFiles.normalize(pathname);
    var result: Array<ProjectInstruction> = [];
    var scope = ".";
    match guide(scope) {
        Some(value) => {
            result = result.push(value);
        }
        None() => (),
    }
    for next in child_scopes(normalized) {
        let entries = perform InstructionFiles.entries(scope);
        if !entries.iter().any(item => item == next) {
            break;
        }
        scope = next;
        match guide(scope) {
            Some(value) => {
                result = result.push(value);
            }
            None() => (),
        }
    }
    return result;
}

flow display<R ~ ProjectRenderer>(renderer: R) -> ![ProjectDisplay => Console, Error<IOError>] ![] {
    return handler {
        ProjectDisplay.item(index, path) => renderer.item(index, path);
        ProjectDisplay.choose() => renderer.choose();
        ProjectDisplay.preview(path) => renderer.preview(path);
    };
}

public flow operations<P ~ RecentProjects, L ~ ProjectLaunchControl, R ~ ProjectRenderer>(
    recent: P,
    launch: L,
    renderer: R
) -> ![
    ProjectOperations => Memory,
    Console,
    Fs.atomic_replace<LaunchRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<fs_IOError>,
    Error<IOError>,
    Error<IndexError>
] ![] {
    let output = display(renderer);
    return handler {
        ProjectOperations.remember(workspace) => remember(recent, workspace);
        ProjectOperations.show() => handle show(recent) with output;
        ProjectOperations.open(raw, workspace, arguments) => handle open(
            recent,
            launch,
            raw,
            workspace,
            arguments
        ) with output;
        ProjectOperations.launch(request) => handle launch_project(launch, request) with output;
    };
}

public flow remember<R ~ RecentProjects>(recent: R, workspace: string) -> unit ![
    Memory,
    Error<StorageError>,
    Error<MemoryConflict>
] {
    recent.save(remembered(workspace, recent.load()));
}

public flow show<R ~ RecentProjects>(recent: R) -> unit ![ProjectDisplay, Memory, Error<StorageError>] {
    var index: usize = 1;
    for value in recent.load() {
        perform ProjectDisplay.item(index, value);
        index = index + 1;
    }
}

public flow launch_project<L ~ ProjectLaunchControl>(control: L, request: LaunchRequest) -> unit
![ProjectDisplay, Fs.atomic_replace<LaunchRoot>, Error<fs_IOError>] {
    perform ProjectDisplay.preview(request.workspace);
    control.publish(request);
}

public flow open<R ~ RecentProjects, L ~ ProjectLaunchControl>(
    recent: R,
    control: L,
    raw: string,
    workspace: string,
    arguments: Array<string>
) -> bool
![
    ProjectDisplay,
    Memory,
    Fs.atomic_replace<LaunchRoot>,
    Error<StorageError>,
    Error<fs_IOError>,
    Error<IndexError>
] {
    var selection = trim(raw);
    if selection == "" {
        show(recent);
        selection = trim(perform ProjectDisplay.choose());
        if selection == "" {
            return false;
        }
    }
    let selected = match reference(selection, workspace) {
        ProjectReference.Saved(index) => saved(recent.load(), index),
        ProjectReference.Folder(path) => path
    };
    launch_project(control, LaunchRequest {
        workspace = selected,
        arguments
    });
    return true;
}

flow location(pathname: string) -> WorkspacePath<ProjectRoot> {
    return match fs_path<ProjectRoot>(pathname) {
        Ok(value) => value,
        Err(_) => abort("invalid project path"),
    };
}

flow discovery_arguments() -> Array<string> {
    return ["--hidden", "--no-require-git", "--color", "never"];
}

flow exclude_internal(arguments: Array<string>) -> Array<string> {
    let settings = perform SettingsContext.current();
    let selected = arguments.extend(
        settings.ignore.iter()
            .flat_map(pattern => ["--glob", "!" + pattern].iter()).collect()
    );
    return selected.extend(["--glob", "!**/.git/**", "--glob", "!**/.nomo/**"]);
}

/// Discover files recursively with ripgrep's glob syntax and ignore rules. Empty glob uses normal ignore rules; an explicit glob has ripgrep's usual override precedence. depth=0 is unlimited. Exit 1 means no matches.
public flow find_files(pathname: string, glob: string, depth: i32) -> CommandOutput
![
    SessionContext.current,
    CommandOperations,
    SettingsContext.current,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    var arguments = discovery_arguments().push("--files").push("--sort").push("path");
    if glob != "" {
        arguments = arguments.push("--glob").push(glob);
    }
    if depth > 0 {
        arguments = arguments.push("--max-depth").push(from_i32(depth));
    }
    arguments = exclude_internal(arguments).push("--").push(relative_name(location(pathname)));
    return execute_readonly("find_files", "/usr/bin/rg", arguments);
}

/// Search a file or directory recursively. regex=true uses ripgrep regular expressions; false searches literal text. Results include actual path and line numbers. Exit 1 means no matches; exit 2 reports an error.
public flow search_project(pathname: string, pattern: string, regex: bool) -> CommandOutput
![
    SessionContext.current,
    CommandOperations,
    SettingsContext.current,
    Memory,
    Command.run<DefaultCommandSandbox>,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IOError>
] {
    var arguments = discovery_arguments().push("--line-number").push("--with-filename").push("--no-heading").push("--sort").push("path");
    if !regex {
        arguments = arguments.push("--fixed-strings");
    }
    arguments = exclude_internal(arguments).push("--").push(pattern).push(relative_name(location(pathname)));
    return execute_readonly("search_project", "/usr/bin/rg", arguments);
}

public flow bindings<H ~ ConversationWriter, F ~ ProjectFileSource, G ~ InstructionReader>(
    history: H,
    files: F,
    guidance: G
) -> ![
    WorkspaceObservations => Memory,
    Fs.read<ProjectRoot>,
    Fs.list<ProjectRoot>,
    Fs.stat<ProjectRoot>,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<fs_IOError>,
    Error<ReadLimitError>,
    Error<BudgetExceeded>
] ![] {
    return handler {
        WorkspaceObservations.read(session, path) => read(history, files, guidance, session, path);
        WorkspaceObservations.instructions(session, path) => instructions(history, guidance, session, path);
        WorkspaceObservations.list(session, path) => list(history, files, session, path);
        WorkspaceObservations.stat(session, path) => stat(history, files, session, path);
        WorkspaceObservations.search(session, paths, literal) => search(
            history,
            files,
            session,
            paths,
            literal
        );
    };
}

flow record<H ~ ConversationWriter, T>(
    history: H,
    session: string,
    role: string,
    name: string,
    value: T,
    call: i64
) -> i64 {
    let text = match encode(value, "history conversion failed", "history encoding failed") {
        Ok(value) => value,
        Err(error) => abort(error),
    };
    return history.append(session, role, name, text, call);
}

// Observations remain available while a mutating request awaits recovery.
// Record the request before IO; publish only the result that actually returned.
public flow read<H ~ ConversationWriter, F ~ ProjectFileSource, G ~ InstructionReader>(
    history: H,
    files: F,
    guidance: G,
    session: string,
    path: string
) -> FileContent {
    let call = record(history, session, "observation_call", "read_file", path, -1);
    let result = FileContent {
        path,
        text = files.text(path),
        instructions = guidance.read(path)
    };
    record(history, session, "tool", "read_file", result, call);
    return result;
}

public flow instructions<H ~ ConversationWriter, G ~ InstructionReader>(
    history: H,
    guidance: G,
    session: string,
    path: string
) -> Array<ProjectInstruction> {
    let call = record(history, session, "observation_call", "project_instructions", path, -1);
    let result = guidance.read(path);
    record(history, session, "tool", "project_instructions", result, call);
    return result;
}

public flow list<H ~ ConversationWriter, F ~ ProjectFileSource>(
    history: H,
    files: F,
    session: string,
    path: string
) -> Array<PathInfo> {
    let call = record(history, session, "observation_call", "list_directory", path, -1);
    let result = files.entries(path);
    record(history, session, "tool", "list_directory", result, call);
    return result;
}

public flow stat<H ~ ConversationWriter, F ~ ProjectFileSource>(
    history: H,
    files: F,
    session: string,
    path: string
) -> PathInfo {
    let call = record(history, session, "observation_call", "stat_file", path, -1);
    let result = files.metadata(path);
    record(history, session, "tool", "stat_file", result, call);
    return result;
}

public flow search<H ~ ConversationWriter, F ~ ProjectFileSource>(
    history: H,
    files: F,
    session: string,
    paths: Array<string>,
    literal: string
) -> Array<MatchLine> {
    let call = record(
        history,
        session,
        "observation_call",
        "search_files",
        SearchRequest {
            paths,
            literal
        },
        -1
    );
    var matches: Array<MatchLine> = [];
    for path in paths {
        var number: usize = 1;
        for line in lines(files.text(path)) {
            if contains(line, literal) {
                matches = matches.push(MatchLine {
                    path,
                    line = number,
                    text = line
                });
            }
            number = number + 1;
        }
    }
    record(history, session, "tool", "search_files", matches, call);
    return matches;
}
