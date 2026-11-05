module nomo.tools.edit_file;

import std.fs.{Region, WorkspacePath, ReadLimitError, path, stat, read_bytes_limited, atomic_replace};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.bytes.len as byte_count;
import std.codec.text.{utf8_encode, utf8_decode, Strict};
import std.agent.message.Message;
import nomo.tools.path_policy.valid_path;
import nomo.harness.edit_original.{OriginalReadFunction, OriginalReader, EditApplier};
import std.text.from_usize;
import nomo.tools.edit_proposal.{validate, text_bytes};
import nomo.core.large_context.{file_bytes, file_metadata_bytes};
public import nomo.tools.edit_contract.{Prepared, prepare_original};

public type EditableRoot;
impl EditableRoot ~ Region;
public type LegacyEditFile = {};
public type WideEditFile = {};
type EditLimit = { bytes: usize, metadata: u64 };
type FileInfo = { is_file: bool, is_dir: bool, len: u64 };

flow checked_path(name: string) -> Result<WorkspacePath<EditableRoot>, string> {
    if !valid_path(name) { return Err("invalid relative path"); }
    let checked: Result<WorkspacePath<EditableRoot>, FileError> = path<EditableRoot>(name);
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
        if byte_count(bytes) > (maximum.bytes) { return Err("edit file exceeds " + from_usize(maximum.bytes) + " bytes after read"); }
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
    match text_bytes(original, "original") { Ok(_) => {} Err(error) => { return Err(error); } }
    return Ok(original);
}

public flow read_original(name: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<IndexError>] ~ OriginalReadFunction<EditableRoot> { let reader = LegacyEditFile {}; return reader.read_original(name); }
public flow read_original_wide(name: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<IndexError>] ~ OriginalReadFunction<EditableRoot> { let reader = WideEditFile {}; return reader.read_original(name); }

public flow prepare_original_legacy(name: string, original: string, target: string, replacement: string) -> Result<Prepared, string> {
    if byte_count(utf8_encode(original)) > 16384 || byte_count(utf8_encode(target)) > 16384 || byte_count(utf8_encode(replacement)) > 16384 { return Err("edit text exceeds 16384 UTF-8 bytes"); }
    let prepared = match prepare_original(name, original, target, replacement) { Ok(value) => value, Err(error) => { return Err(error); } };
    if byte_count(utf8_encode(prepared.proposal.after)) > 16384 { return Err("edit result exceeds 16384 UTF-8 bytes"); }
    return Ok(prepared);
}

public flow prepare(name: string, target: string, replacement: string) -> Result<Prepared, string> {
    let original = match read_original(name) { Ok(value) => value, Err(error) => { return Err(error); } };
    return prepare_original_legacy(name, original, target, replacement);
}

// Called once only after confirmed current consent and a durable intent. A File
// exception can follow publication: no caller may infer rollback or retry it.
flow apply_with(prepared: Prepared, maximum: EditLimit) -> Result<bool, string> {
    let proposal = match validate(prepared.request, prepared.proposal) { Ok(value) => value, Err(error) => { return Err(error); } };
    if byte_count(utf8_encode(proposal.after)) > (maximum.bytes) { return Err("edit result exceeds its byte limit"); }
    let before = match read_existing(proposal.path, maximum) { Ok(value) => value, Err(error) => { return Err(error); } };
    if before != utf8_encode(proposal.before) { return Err("edit original changed; intent retained, no write"); }
    let target = match checked_path(proposal.path) { Ok(value) => value, Err(error) => { return Err(error); } };
    atomic_replace(target, utf8_encode(proposal.after));
    let observed = match read_existing(proposal.path, maximum) { Ok(value) => value, Err(error) => { return Err(error); } };
    if observed != utf8_encode(proposal.after) { return Err("edit result readback mismatch; intent retained, no retry"); }
    return Ok(true);
}

public flow apply(prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>] { let writer = LegacyEditFile {}; return writer.apply(prepared); }


impl LegacyEditFile ~ OriginalReader<EditableRoot> {
    flow read_original(self, name: string) -> Result<string, string> { return read_original_with(name, EditLimit { bytes = 16384, metadata = 16384 }); }
}
impl WideEditFile ~ OriginalReader<EditableRoot> {
    flow read_original(self, name: string) -> Result<string, string> { return read_original_with(name, EditLimit { bytes = file_bytes(), metadata = file_metadata_bytes() }); }
}
impl LegacyEditFile ~ EditApplier<EditableRoot> {
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>] { return apply_with(prepared, EditLimit { bytes = 16384, metadata = 16384 }); }
}
impl WideEditFile ~ EditApplier<EditableRoot> {
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>] { return apply_with(prepared, EditLimit { bytes = file_bytes(), metadata = file_metadata_bytes() }); }
}
