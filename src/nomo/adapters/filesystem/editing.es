module nomo.adapters.filesystem.editing;

import nomo.adapters.filesystem.workspace.read_text;
import nomo.application.editing.ports.{
    EditApplier,
    MutationFileAccess,
    OriginalReadFunction,
    OriginalReader,
    WorkEditor
};
import nomo.application.execution.commands.execute_step;
import nomo.application.execution.ports.CommandOperations;
import nomo.application.scope.SessionContext;
import nomo.domain.changes.parent;
import nomo.domain.editing.{Prepared, prepare_original_legacy, text_bytes, validate};
import nomo.domain.limits.{file_bytes, file_metadata_bytes};
import nomo.domain.workspace.valid_path;
import nomo.native.workspace.ProjectRoot;
import nomo.tools.edit_file.EditableRoot;
import std.agent.message.Message;
import std.bytes.len;
import std.codec.text.{Strict, utf8_decode, utf8_encode};
import std.effects.Fs;
import std.fs.{
    IOError as fs_IOError,
    ReadLimitError,
    WorkspacePath,
    atomic_replace,
    list,
    path as fs_path,
    read_bytes_limited,
    relative_name,
    stat
};
import std.io.IOError;
import std.text.{from_usize, len as text_len};

public type LegacyEditFile = {};

public type WideEditFile = {};

flow checked_path(name: string) -> Result<WorkspacePath<EditableRoot>, string> {
    if !valid_path(name) { return Err("invalid relative path"); }
    let checked: Result<WorkspacePath<EditableRoot>, fs_IOError> = fs_path<EditableRoot>(name);
    return match checked { Ok(value) => Ok(value), Err(_) => Err("edit path construction refused") };
}

// This stat is not lstat/inode identity or a concurrent-file guarantee. The
// caller uses an owned regular-file tree without symlinks or concurrent writers.
flow read_existing(name: string, maximum: EditLimit) -> Result<bytes, string> {
    let target = match checked_path(name) { Ok(value) => value, Err(error) => { return Err(error); } };
    let message = Message.new(stat(target));
    let conversion: Option<Message<FileInfo>> = message.cast<FileInfo>();
    let info = match conversion { Some(value) => value.body, None() => { return Err("edit stat projection refused"); } };
    if !info.is_file || info.is_dir { return Err("edit requires an existing regular file"); }
    if info.len > maximum.metadata { return Err("edit file exceeds " + from_usize(maximum.bytes) + " bytes"); }
    return handle {
        let bytes = read_bytes_limited(target, maximum.bytes);
        if len(bytes) > (maximum.bytes) { return Err("edit file exceeds " + from_usize(maximum.bytes) + " bytes after read"); }
        Ok(bytes)
    } with {
        Error<ReadLimitError>.raise(ReadLimitError.LimitExceeded(observed_limit)) => {
            if observed_limit != maximum.bytes { abort("unexpected edit read limit"); }
            finish Err("edit file exceeds " + from_usize(maximum.bytes) + " bytes after read");
        }
    };
}

flow read_original_with(name: string, maximum: EditLimit) -> Result<string, string> {
    let bytes = match read_existing(name, maximum) { Ok(value) => value, Err(error) => { return Err(error); } };
    let original = match utf8_decode(bytes, Strict) { Ok(value) => value, Err(_) => { return Err("edit file is not UTF-8"); } };
    match text_bytes(original, "original") { Ok(_) => (), Err(error) => { return Err(error); } }
    return Ok(original);
}

public flow read_original(name: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] ~ OriginalReadFunction<EditableRoot> { let reader = LegacyEditFile {}; return reader.read_original(name); }

public flow read_original_wide(name: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] ~ OriginalReadFunction<EditableRoot> { let reader = WideEditFile {}; return reader.read_original(name); }

public flow prepare(name: string, target: string, replacement: string) -> Result<Prepared, string> {
    let original = match read_original(name) { Ok(value) => value, Err(error) => { return Err(error); } };
    return prepare_original_legacy(name, original, target, replacement);
}

// Called once only after confirmed current consent and a durable intent. A File
// exception can follow publication: no caller may infer rollback or retry it.
flow apply_with(prepared: Prepared, maximum: EditLimit) -> Result<bool, string> {
    let proposal = match validate(prepared.request, prepared.proposal) { Ok(value) => value, Err(error) => { return Err(error); } };
    if text_len(proposal.after) > (maximum.bytes) { return Err("edit result exceeds its byte limit"); }
    let before = match read_existing(proposal.path, maximum) { Ok(value) => value, Err(error) => { return Err(error); } };
    if before != utf8_encode(proposal.before) { return Err("edit original changed; intent retained, no write"); }
    let target = match checked_path(proposal.path) { Ok(value) => value, Err(error) => { return Err(error); } };
    atomic_replace(target, utf8_encode(proposal.after));
    let observed = match read_existing(proposal.path, maximum) { Ok(value) => value, Err(error) => { return Err(error); } };
    if observed != utf8_encode(proposal.after) { return Err("edit result readback mismatch; intent retained, no retry"); }
    return Ok(true);
}

public flow apply(prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] { let writer = LegacyEditFile {}; return writer.apply(prepared); }

impl LegacyEditFile ~ OriginalReader<EditableRoot> {
    flow read_original(self, name: string) -> Result<string, string> { return read_original_with(name, EditLimit { bytes = 16384, metadata = 16384 }); }
}

impl WideEditFile ~ OriginalReader<EditableRoot> {
    flow read_original(self, name: string) -> Result<string, string> { return read_original_with(name, EditLimit { bytes = file_bytes(), metadata = file_metadata_bytes() }); }
}

impl LegacyEditFile ~ EditApplier<EditableRoot> {
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] { return apply_with(prepared, EditLimit { bytes = 16384, metadata = 16384 }); }
}

impl WideEditFile ~ EditApplier<EditableRoot> {
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] { return apply_with(prepared, EditLimit { bytes = file_bytes(), metadata = file_metadata_bytes() }); }
}

public type LegacyWorkEditor = {};

impl LegacyWorkEditor ~ WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] {
        return read_original(path);
    }
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] {
        return apply(prepared);
    }
}

flow location(name: string) -> WorkspacePath<ProjectRoot> {
    return match fs_path<ProjectRoot>(name) { Ok(value) => value, Err(_) => abort("invalid project path"), };
}

public type ProjectMutationFiles = {};

impl ProjectMutationFiles ~ MutationFileAccess {
    flow backup(self, id: string) -> string ![] { return "/native-state/edits/" + id; }
    flow normalize(self, name: string) -> string ![] { return relative_name(location(name)); }
    flow exists(self, name: string) -> bool ![Fs.list<ProjectRoot>, Error<fs_IOError>] {
        for item in list(location(parent(name))) {
            if relative_name(item) == name { return true; }
        }
        return false;
    }
    flow read(self, name: string) -> string ![Fs.read<ProjectRoot>, Error<fs_IOError>, Error<ReadLimitError>] { return read_text(name); }
    flow replace(self, name: string, text: string) -> unit ![Fs.atomic_replace<ProjectRoot>, Error<fs_IOError>] { atomic_replace(location(name), utf8_encode(text)); }
    flow command(self, program: string, arguments: Array<string>, call: i64) -> bool ![SessionContext.current, CommandOperations, Memory, Console, Command.run<DefaultCommandSandbox>, Error<StorageError>, Error<MemoryConflict>, Error<IOError>] {
        return execute_step(program, arguments, call).exit_code == 0;
    }
}

public type NativeWorkEditor = {};

impl NativeWorkEditor ~ WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] {
        return read_original_wide(path);
    }
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<fs_IOError>, Error<IndexError>, Error<BudgetExceeded>] {
        return WideEditFile {}.apply(prepared);
    }
}

public type EditLimit = { bytes: usize, metadata: u64 };

public type FileInfo = { is_file: bool, is_dir: bool, len: u64 };
