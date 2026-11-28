module nomo.adapters.filesystem.workspace;

import nomo.application.transfer.ports.ArchiveWorkspace;
import nomo.application.workspace.ports.{
    ConfigurationFile,
    FileReader,
    InstructionFileSource,
    InstructionFiles,
    InstructionReader,
    LiteralSearcher,
    NomoRead,
    NomoSearch,
    ProjectFileSource,
    ProjectLaunchControl,
    SearchBounds
};
import nomo.application.workspace.service.load;
import nomo.domain.harness.loop.candidate_error;
import nomo.domain.limits.{file_bytes, message_bytes};
import nomo.domain.text.search_literal;
import nomo.domain.wire.encode;
import nomo.domain.workspace.{
    DiscoveredFileInfo,
    Discovery,
    LaunchRequest,
    Outcome,
    PathInfo,
    ProjectInstruction,
    outcome,
    valid_path
};
import nomo.native.projects.LaunchRoot;
import nomo.native.workspace.ProjectRoot;
import nomo.tools.workspace.ReadOnlyRoot;
import std.agent.message.Message;
import std.bytes.len;
import std.codec.text.{Strict, utf8_decode, utf8_encode};
import std.effects.Fs;
import std.fs.{
    IOError as fs_IOError,
    ListLimitError,
    ReadLimitError,
    WorkspacePath,
    atomic_replace,
    list,
    list_limited,
    path as fs_path,
    read_bytes_limited,
    relative_name,
    root as fs_root,
    stat
};
import std.io.{IOError, println};
import std.text.{char_count, contains, from_usize, split, starts_with};

public type ProjectArchives = {};

impl ProjectArchives ~ ArchiveWorkspace {
    flow target(self, pathname: string) -> WorkspacePath<ProjectRoot> ![] {
        return match fs_path<ProjectRoot>(pathname) {
            Ok(value) => value,
            Err(_) => abort("invalid conversation export path"),
        };
    }

    flow read(self, pathname: string) -> string ![
        Fs.read<ProjectRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>
    ] {
        let location = match fs_path<ProjectRoot>(pathname) {
            Ok(value) => value,
            Err(_) => abort("invalid conversation import path"),
        };
        return match utf8_decode(read_bytes_limited(location, 536870912), Strict) {
            Ok(value) => value,
            Err(_) => abort("conversation archive must be UTF-8"),
        };
    }

    flow replace(self, target: WorkspacePath<ProjectRoot>, text: string) -> unit ![
        Fs.atomic_replace<ProjectRoot>,
        Error<fs_IOError>
    ] {
        atomic_replace(target, utf8_encode(text));
    }
}

public type ProjectConfigurationFile = {};

impl ProjectConfigurationFile ~ ConfigurationFile {
    flow read(self) -> Option<string> ![
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>
    ] {
        let root = match fs_path<ProjectRoot>(".") {
            Ok(value) => value,
            Err(_) => abort("project root unavailable"),
        };
        let configured = list(root).iter().any(item => relative_name(item) == ".nomo.toml");
        return if configured {
            Some(read_text(".nomo.toml"))
        } else {
            None()
        };
    }
}

public flow read_text(pathname: string) -> string {
    let location = match fs_path<ProjectRoot>(pathname) {
        Ok(value) => value,
        Err(_) => abort("invalid project file path"),
    };
    return match utf8_decode(read_bytes_limited(location, 536870912), Strict) {
        Ok(value) => value,
        Err(_) => abort("project file is not UTF-8"),
    };
}

public type ProjectInstructionFiles = {};

impl ProjectInstructionFiles ~ InstructionFileSource {
    flow normalize(self, pathname: string) -> string ![] {
        let selected = match fs_path<ProjectRoot>(pathname) {
            Ok(value) => value,
            Err(_) => abort("invalid project instruction path"),
        };
        return relative_name(selected);
    }

    flow entries(self, scope: string) -> Array<string> ![Fs.list<ProjectRoot>, Error<fs_IOError>] {
        let selected = match fs_path<ProjectRoot>(scope) {
            Ok(value) => value,
            Err(_) => abort("invalid project instruction path"),
        };
        return list(selected).iter().map(item => relative_name(item)).collect();
    }

    flow text(self, pathname: string) -> string ![
        Fs.read<ProjectRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>
    ] {
        return read_text(pathname);
    }
}

impl ProjectInstructionFiles ~ InstructionReader {
    flow read(self, pathname: string) -> Array<ProjectInstruction> ![
        Fs.read<ProjectRoot>,
        Fs.list<ProjectRoot>,
        Error<fs_IOError>,
        Error<ReadLimitError>
    ] {
        return load(pathname) with {
            InstructionFiles.normalize(name) => self.normalize(name);
            InstructionFiles.entries(scope) => self.entries(scope);
            InstructionFiles.text(name) => self.text(name);
        };
    }
}

public type NativeProjectLaunch = {};

impl NativeProjectLaunch ~ ProjectLaunchControl {
    flow publish(self, request: LaunchRequest) -> unit ![Fs.atomic_replace<LaunchRoot>, Error<fs_IOError>] {
        let target = match fs_path<LaunchRoot>("next-project") {
            Ok(value) => value,
            Err(_) => abort("native launch control is unavailable"),
        };
        let text = match encode(request, "launch request conversion failed", "launch request encoding failed") {
            Ok(value) => value,
            Err(error) => abort(error),
        };
        atomic_replace(target, utf8_encode(text));
    }
}

public type StandardFiles = {};

public type WideFiles = {};

public type MultiFiles = {};

impl StandardFiles ~ FileReader<ReadOnlyRoot> {
    flow maximum_bytes(self) -> usize ![] {
        return 16384;
    }

    flow read(self, name: string) -> Outcome {
        return read_bounded(name, self.maximum_bytes());
    }
}

impl WideFiles ~ FileReader<ReadOnlyRoot> {
    flow maximum_bytes(self) -> usize ![] {
        return file_bytes();
    }

    flow read(self, name: string) -> Outcome {
        return read_bounded(name, self.maximum_bytes());
    }
}

impl StandardFiles ~ LiteralSearcher<ReadOnlyRoot> {
    flow bounds(self) -> SearchBounds ![] {
        return SearchBounds {
            files = 4,
            file_bytes = 16384,
            total_bytes = 16384,
            partial_results = false
        };
    }

    flow search(self, names: Array<string>, literal: string) -> Outcome {
        return search_files(names, literal);
    }
}

impl WideFiles ~ LiteralSearcher<ReadOnlyRoot> {
    flow bounds(self) -> SearchBounds ![] {
        return SearchBounds {
            files = 4,
            file_bytes = file_bytes(),
            total_bytes = file_bytes(),
            partial_results = false
        };
    }

    flow search(self, names: Array<string>, literal: string) -> Outcome {
        return search_wide(names, literal);
    }
}

impl MultiFiles ~ LiteralSearcher<ReadOnlyRoot> {
    flow bounds(self) -> SearchBounds ![] {
        return SearchBounds {
            files = 256,
            file_bytes = file_bytes(),
            total_bytes = 4194304,
            partial_results = true
        };
    }

    flow search(self, names: Array<string>, literal: string) -> Outcome {
        return if names[0] == "*" {
            search_files(names, literal)
        } else {
            search_wide(names, literal)
        };
    }
}

flow target(name: string) -> WorkspacePath<ReadOnlyRoot> {
    let checked: Result<WorkspacePath<ReadOnlyRoot>, fs_IOError> = fs_path<ReadOnlyRoot>(name);
    return match checked {
        Ok(value) => value,
        Err(_) => abort("read-only path construction refused"),
    };
}

flow excluded(name: string) -> bool {
    @limits([Iterations(8)]) for part in split(name, "/") {
        let excluded = "|.git|.hg|.svn|.bzr|.venv|.tox|.cache|.mypy_cache|.pytest_cache|.ssh|.aws|.gnupg|.netrc|node_modules|target|build|dist|vendor|";
        if contains(excluded, "|" + part + "|") {
            return true;
        }
        if part == ".env" || (starts_with(part, ".env.") && part != ".env.example" && part != ".env.sample") {
            return true;
        }
    }
    return false;
}

public flow discover(page: usize) -> Result<Discovery, string> ![
    Console,
    Fs.list<ReadOnlyRoot>,
    Fs.stat<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    return handle {
        var dirs: Array<WorkspacePath<ReadOnlyRoot>> = [fs_root<ReadOnlyRoot>()];
        var depths: Array<usize> = [0];
        var files: Array<string> = [];
        var i: usize = 0;
        var deep = false;
        var unsupported = false;
        var seen: usize = 0;
        var more = false;
        @limits([Iterations(512)]) while i < dirs.len() && !more {
            let entries = list_limited(dirs[i], 1024, 131072);
            @limits([Iterations(1024)]) for entry in entries {
                let name = relative_name(entry);
                if !excluded(name) {
                    if !valid_path(name) {
                        unsupported = true;
                    }
                    else {
                        let projected: Option<Message<DiscoveredFileInfo>> = Message.new(stat(entry)).cast<DiscoveredFileInfo>();
                        let info = match projected {
                            Some(value) => value.body,
                            None() => {
                                return Err("file metadata unavailable");
                            }
                        };
                        if info.is_file {
                            if seen >= page * 256 {
                                if files.len() == 256 {
                                    more = true;
                                    break;
                                }
                                files = files.push(name);
                            }
                            seen = seen + 1;
                        }
                        else if info.is_dir && depths[i] < 7 {
                            if dirs.len() >= 512 {
                                return Err("discovery exceeds 512 directories; select a narrower root");
                            }
                            dirs = dirs.push(entry);
                            depths = depths.push(depths[i] + 1);
                        }
                        else if info.is_dir {
                            deep = true;
                        } else {
                            unsupported = true;
                        }
                    }
                }
            }
            i = i + 1;
        }
        if deep {
            println("DISCOVERY INCOMPLETE: directories beyond seven levels were not visited.");
        }
        if unsupported {
            println("DISCOVERY INCOMPLETE: unsupported names or file types were omitted.");
        }
        if files.len() == 0 {
            return Err("discovery page is empty");
        }
        println("DISCOVERY PAGE " + from_usize(page) + (if more {
            ": more candidates remain."
        } else {
            ": no later candidates found within discovery bounds."
        }));
        return Ok(Discovery {
            files,
            page,
            more
        });
    } with {
        Error<ListLimitError>.raise(_) => finish Err("directory exceeds 1024 entries or 131072 name bytes; select a narrower root");
    };
}

// Select an explicit list or a bounded discovery page. All membership is revalidated per turn.
public flow selection(raw: string) -> Result<Discovery, string> {
    if raw == "*" {
        return discover(0);
    }
    let pages = ["*0", "*1", "*2", "*3", "*4", "*5", "*6", "*7"];
    var page: usize = 0;
    @limits([Iterations(8)]) for token in pages {
        if raw == token {
            return discover(page);
        }
        page = page + 1;
    }
    let names = split(raw, ",");
    if names.len() > 4 {
        return Err("explicit selection supports up to four files");
    }
    return Ok(Discovery {
        files = names,
        page = 0,
        more = false
    });
}

// The Host enforces the byte cap while reading; overflow never returns a prefix.
flow read_bounded(name: string, bound: usize) -> Outcome ![
    Fs.read<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if !valid_path(name) {
        return outcome("refused", "invalid relative path", 0);
    }
    return handle {
        let bytes = read_bytes_limited(target(name), bound);
        let decoded = utf8_decode(bytes, Strict);
        match decoded {
            Err(_) => outcome("unsupported", "file is not UTF-8", 0),
            Ok(text) => outcome("complete", text, len(bytes)),
        }
    } with {
        Error<ReadLimitError>.raise(ReadLimitError.LimitExceeded(maximum)) => {
            if maximum != bound {
                abort("unexpected workspace read limit");
            }
            finish outcome(
                "refused",
                if bound == 16384 {
                    "file exceeds 16384 bytes"
                } else {
                    if bound == file_bytes() {
                        "file exceeds " + from_usize(file_bytes()) + " bytes"
                    } else {
                        if bound == 2048 {
                            "file exceeds 2048 bytes"
                        } else {
                            "file exceeds remaining scan allowance"
                        }
                    }
                },
                0
            );
        }
    };
}

public flow read_file(name: string) -> Outcome ![
    Fs.read<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] ~ NomoRead<ReadOnlyRoot> {
    return read_bounded(name, 16384);
}

public flow read_legacy(name: string) -> Outcome ![
    Fs.read<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] ~ NomoRead<ReadOnlyRoot> {
    return read_bounded(name, 2048);
}

// Opaque paths can be counted but this accepted API exposes no name projection.
// Do not invent names or mistake a count for the requested named-entry listing.
public flow list_directory(name: string) -> Outcome {
    if !valid_path(name) {
        return outcome("refused", "invalid relative path", 0);
    }
    let entries = list(target(name));
    if entries.len() > 16 {
        return outcome("refused", "directory exceeds 16 entries (post-list check)", 0);
    }
    return outcome(
        "unsupported",
        "named listing unavailable: opaque WorkspacePath; entries=" + from_usize(entries.len()),
        0
    );
}

// Search selected files within the scan reservation. Result text has the same
// message capacity as model answers; a byte-sized file can have at most n+1 lines.
// A Host overflow check may probe one additional byte, never return a prefix.
flow search_with(names: Array<string>, literal: string, maximum: usize) -> Outcome ![
    Fs.read<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] {
    if names.len() == 0 || names.len() > (if maximum == 4194304 {
        256
    } else {
        4
    }) {
        return outcome("refused", "search file count exceeds scope", 0);
    }
    if !search_literal(literal) {
        return outcome("refused", "literal must be 1..65536 safe UTF-8 bytes", 0);
    }
    let invalid = candidate_error(names);
    if invalid != "" {
        return outcome("refused", invalid, 0);
    }
    var output = "";
    var scanned: usize = 0;
    var consumed: usize = 0;
    var matches: usize = 0;
    var skipped: usize = 0;
    var skipped_names = "";
    @limits([Iterations(256)]) for name in names {
        let remaining = maximum - consumed;
        let per_file = if maximum == 4194304 || maximum == file_bytes() {
            file_bytes()
        } else {
            if maximum == 4096 {
                2048
            } else {
                16384
            }
        };
        let bound = if remaining < per_file {
            remaining
        } else {
            per_file
        };
        let file = read_bounded(name, bound);
        if file.status != "complete" {
            if maximum != 4194304 {
                return outcome(file.status, name + ": " + file.text, scanned);
            }
            consumed = consumed + bound + 1;
            skipped = skipped + 1;
            if char_count(skipped_names) + char_count(name) < message_bytes() {
                skipped_names = skipped_names + name + "\n";
            }
        } else {
            consumed = consumed + file.scanned;
            let lines = split(file.text, "\n");
            let line_limit = file_bytes() + 1;
            if lines.len() > line_limit {
                return outcome("refused", "file exceeds line limit", scanned);
            }
            scanned = scanned + file.scanned;
            var line: usize = 0;
            @limits([Iterations(1048577)]) for text in lines {
                line = line + 1;
                if contains(text, literal) {
                    let entry = name + ":" + from_usize(line) + "\n";
                    if matches >= 65536 || char_count(output) + char_count(entry) > message_bytes() {
                        return outcome(
                            if maximum == 4194304 {
                                "incomplete"
                            } else {
                                "truncated"
                            },
                            if maximum == 4194304 {
                                "match limit reached; partial results\n" + output
                            } else {
                                output
                            },
                            scanned
                        );
                    }
                    output = output + entry;
                    matches = matches + 1;
                }
            }
        }
        if maximum == 4194304 && consumed >= maximum && name != names[names.len() - 1] {
            consumed = maximum + 1;
            break;
        }
    }
    if skipped > 0 || consumed > maximum {
        return outcome(
            "incomplete",
            (if consumed > maximum {
                "scan allowance exhausted; "
            } else {
                ""
            }) + "skipped " + from_usize(skipped)
                + " unsupported or oversized files; partial results; skipped names (may be partial):\n"
                + skipped_names + "matches:\n" + output,
            scanned
        );
    }
    return outcome("complete", output, scanned);
}

public flow search_files(names: Array<string>, literal: string) -> Outcome ![
    Fs.read<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] ~ NomoSearch<ReadOnlyRoot> {
    if names.len() > 0 && names[0] == "*" {
        if names.len() > 257 {
            return outcome("refused", "search file count exceeds scope", 0);
        }
        var selected: Array<string> = [];
        var i: usize = 1;
        selected = selected.extend(names.iter().skip(i).collect());
        return search_with(selected, literal, 4194304);
    }
    return search_with(names, literal, 16384);
}

public flow search_wide(names: Array<string>, literal: string) -> Outcome ![
    Fs.read<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] ~ NomoSearch<ReadOnlyRoot> {
    return search_with(names, literal, file_bytes());
}

public flow search_legacy(names: Array<string>, literal: string) -> Outcome ![
    Fs.read<ReadOnlyRoot>,
    Error<fs_IOError>,
    Error<IndexError>,
    Error<BudgetExceeded>
] ~ NomoSearch<ReadOnlyRoot> {
    return search_with(names, literal, 4096);
}

type Metadata = {
    is_file: bool,
    is_dir: bool,
    len: u64
};

flow location(pathname: string) -> WorkspacePath<ProjectRoot> {
    return match fs_path<ProjectRoot>(pathname) {
        Ok(value) => value,
        Err(_) => abort("invalid project path"),
    };
}

flow info(pathname: WorkspacePath<ProjectRoot>) -> PathInfo {
    let converted: Option<Message<Metadata>> = Message.new(stat(pathname)).cast<Metadata>();
    let metadata = match converted {
        Some(value) => value.body,
        None() => abort("filesystem metadata projection failed"),
    };
    return PathInfo {
        path = relative_name(pathname),
        is_file = metadata.is_file,
        is_dir = metadata.is_dir,
        bytes = metadata.len
    };
}

public type ProjectFiles = {};

impl ProjectFiles ~ ProjectFileSource {
    flow text(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<fs_IOError>, Error<ReadLimitError>] {
        return read_text(path);
    }

    flow entries(self, path: string) -> Array<PathInfo> ![
        Fs.list<ProjectRoot>,
        Fs.stat<ProjectRoot>,
        Error<fs_IOError>,
        Error<BudgetExceeded>
    ] {
        return list(location(path)).iter().map_collect(item => info(item));
    }

    flow metadata(self, path: string) -> PathInfo ![Fs.stat<ProjectRoot>, Error<fs_IOError>] {
        return info(location(path));
    }
}
