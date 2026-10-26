module nomo.tools.edit_file;

import std.fs.{Region, WorkspacePath, path, stat, read_bytes, atomic_replace};
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.bytes.len as byte_count;
import std.codec.text.{utf8_encode, utf8_decode, Strict};
import std.agent.message.Message;
import nomo.tools.path_policy.valid_path;
import nomo.tools.edit_proposal.{Request, Proposal, propose, validate};

public type EditableRoot;
impl EditableRoot ~ Region;
public type Prepared = { request: Request, proposal: Proposal };
type FileInfo = { is_file: bool, is_dir: bool, len: u64 };

flow checked_path(name: string) -> Result<WorkspacePath<EditableRoot>, string> {
    if !valid_path(name) { return Err("invalid relative path"); }
    let checked: Result<WorkspacePath<EditableRoot>, FileError> = path<EditableRoot>(name);
    return match checked { Ok(value) => Ok(value), Err(_) => Err("edit path construction refused") };
}

// This stat is not lstat/inode identity or a concurrent-file guarantee. The
// caller provisions an exclusive private regular-file tree without symlinks.
flow read_existing(name: string) -> Result<bytes, string> {
    let target = match checked_path(name) { Ok(value) => value, Err(error) => { return Err(error); } };
    let message = Message.new(stat(target));
    let conversion: Option<Message<FileInfo>> = message.cast<FileInfo>();
    let info = match conversion { Some(value) => value.body, None() => { return Err("edit stat projection refused"); } };
    if !info.is_file || info.is_dir { return Err("edit requires an existing regular file"); }
    if info.len > 2048 { return Err("edit file exceeds 2048 bytes"); }
    let bytes = read_bytes(target);
    if byte_count(bytes) > 2048 { return Err("edit file exceeds 2048 bytes after read"); }
    return Ok(bytes);
}

public flow prepare(name: string, target: string, replacement: string) -> Result<Prepared, string> {
    let bytes = match read_existing(name) { Ok(value) => value, Err(error) => { return Err(error); } };
    let original = match utf8_decode(bytes, Strict) { Ok(value) => value, Err(_) => { return Err("edit file is not UTF-8"); } };
    let request = Request { path = name, original = original, target = target, replacement = replacement };
    let proposal = match propose(request) { Ok(value) => value, Err(error) => { return Err(error); } };
    return Ok(Prepared { request = request, proposal = proposal });
}

// Called once only after confirmed current consent and a durable intent. A File
// exception can follow publication: no caller may infer rollback or retry it.
public flow apply(prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>] {
    let proposal = match validate(prepared.request, prepared.proposal) { Ok(value) => value, Err(error) => { return Err(error); } };
    let before = match read_existing(proposal.path) { Ok(value) => value, Err(error) => { return Err(error); } };
    if before != utf8_encode(proposal.before) { return Err("edit original changed; intent retained, no write"); }
    let target = match checked_path(proposal.path) { Ok(value) => value, Err(error) => { return Err(error); } };
    atomic_replace(target, utf8_encode(proposal.after));
    let observed = match read_existing(proposal.path) { Ok(value) => value, Err(error) => { return Err(error); } };
    if observed != utf8_encode(proposal.after) { return Err("edit result readback mismatch; intent retained, no retry"); }
    return Ok(true);
}
