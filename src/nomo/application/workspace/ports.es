module nomo.application.workspace.ports;

import nomo.application.execution.ports.CommandOperations;
import nomo.application.resources.{LaunchRoot, ProjectRoot};
import nomo.domain.settings.{CachedConfiguration, Settings};
import nomo.domain.workspace.{FileContent, LaunchRequest, MatchLine, Outcome, PathInfo, ProjectInstruction};
import std.effects.Fs;
import std.fs.{IOError as fs_IOError, ReadLimitError, Region};
import std.io.IOError;
import std.runtime.error.IndexError;

public spec ConfigurationFile {
    flow read(self) -> Option<string> ![
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>
    ];
}

public spec EntriesCodec {
    flow fingerprint(self, raw: string) -> bytes ![];
    flow decode_json(self, text: string) -> Settings ![];
    flow observation(self, text: string) -> ConfigurationOutput ![];
}

public spec TomlConverter {
    flow toml(self, session: string, raw: string) -> Converted ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<BudgetExceeded>
    ];
    flow entries(self, session: string, json: string) -> Converted ![
        CommandOperations,
        Memory,
        Console,
        Command.run<DefaultCommandSandbox>,
        Error<StorageError>,
        Error<MemoryConflict>,
        Error<IOError>,
        Error<BudgetExceeded>
    ];
}

public spec ConfigurationCacheStore {
    flow lookup(self, workspace: string) -> Option<CachedConfiguration> ![Memory, Error<StorageError>];
    flow remember(self, workspace: string, value: CachedConfiguration) -> unit ![
        Memory,
        Error<StorageError>,
        Error<MemoryConflict>
    ];
}

public effect ReadTools {
    action read(name: string) -> Outcome;
    action search(names: Array<string>, literal: string) -> Outcome;
}

public spec InstructionReader {
    flow read(self, path: string) -> Array<ProjectInstruction> ![
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>
    ];
}

public effect InstructionFiles {
    action normalize(path: string) -> string;
    action entries(scope: string) -> Array<string>;
    action text(path: string) -> string;
}

public spec InstructionFileSource {
    flow normalize(self, path: string) -> string ![];
    flow entries(self, scope: string) -> Array<string> ![Fs.list<ProjectRoot>, Error<fs_IOError>];
    flow text(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<fs_IOError>, Error<ReadLimitError>];
}

public effect ProjectDisplay {
    action item(index: usize, path: string) -> unit;
    action choose() -> string;
    action preview(path: string) -> unit;
}

public effect ProjectOperations {
    action remember(workspace: string) -> unit;
    action show() -> unit;
    action open(raw: string, workspace: string, arguments: Array<string>) -> bool;
    action launch(request: LaunchRequest) -> unit;
}

public spec RecentProjects {
    flow load(self) -> Array<string> ![Memory, Error<StorageError>];
    flow save(self, folders: Array<string>) -> unit ![Memory, Error<StorageError>, Error<MemoryConflict>];
}

public spec ProjectLaunchControl {
    flow publish(self, request: LaunchRequest) -> unit ![Fs.atomic_replace<LaunchRoot>, Error<fs_IOError>];
}

public spec ProjectRenderer {
    flow item(self, index: usize, path: string) -> unit ![Console, Error<IOError>];
    flow choose(self) -> string ![Console, Error<IOError>];
    flow preview(self, path: string) -> unit ![Console, Error<IOError>];
}

public spec ProjectFileSource {
    flow text(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<fs_IOError>, Error<ReadLimitError>];
    flow entries(self, path: string) -> Array<PathInfo> ![
        Fs.list<ProjectRoot>,
        Fs.stat<ProjectRoot>,
        Error<fs_IOError>,
        Error<BudgetExceeded>
    ];
    flow metadata(self, path: string) -> PathInfo ![Fs.stat<ProjectRoot>, Error<fs_IOError>];
}

public effect WorkspaceObservations {
    action read(session: string, path: string) -> FileContent;
    action instructions(session: string, path: string) -> Array<ProjectInstruction>;
    action list(session: string, path: string) -> Array<PathInfo>;
    action stat(session: string, path: string) -> PathInfo;
    action search(session: string, paths: Array<string>, literal: string) -> Array<MatchLine>;
}

// Views of existing saved command observations; no new stored representation.
public type ConfigurationOutput = {
    exit_code: i32,
    stdout: string,
    stderr: string
};

public type Converted = {
    result_event: i64,
    output: ConfigurationOutput
};

public type SearchBounds = {
    files: usize,
    file_bytes: usize,
    total_bytes: usize,
    partial_results: bool
};

public spec FileReader<R ~ Region> {
    flow maximum_bytes(self) -> usize ![];
    flow read(self, name: string) -> Outcome ![
        Fs.read<R>,
        Error<fs_IOError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec LiteralSearcher<R ~ Region> {
    flow bounds(self) -> SearchBounds ![];
    flow search(self, names: Array<string>, literal: string) -> Outcome ![
        Fs.read<R>,
        Error<fs_IOError>,
        Error<IndexError>,
        Error<BudgetExceeded>
    ];
}

public spec NomoRead<R ~ Region>: callable string => Outcome ![
    Fs.read<R>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
];

public spec NomoSearch<R ~ Region>: callable (Array<string>, string) => Outcome ![
    Fs.read<R>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
];
