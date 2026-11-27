module nomo.adapters.filesystem.native_migration;

import std.effects.Fs;
import std.fs.{path, read_bytes_limited, IOError as FileError, ReadLimitError};
import std.codec.text.{utf8_decode, Strict};
import std.json.parse;
import std.agent.message.Message;
import std.bytes.from_array;
import std.text.{parse_i64, parse_i32, parse_usize};
import nomo.application.migration.ports.{NativeStateSource, MigrationRoot};
import nomo.domain.migration.native_state.{NativeImage, NativeRecord};
import nomo.domain.conversation.session.{Session, Ledger};
import nomo.native.history.Event;
import nomo.domain.transfer.copy.CopyJob;
import nomo.domain.execution.attempt.Attempt;
import nomo.native.configuration.Cached;
import nomo.native.mutations.{Journal, Step};
import nomo.domain.process.jobs.{Job, JobEvent};

// Decimal strings preserve all old i64/usize values through JSON's number type.
type WireRow = { store: string, key: string, value: string };
type Packet = { format: string, source_sha256: string, rows: Array<WireRow> };
type WireLedger = { turns: string, compactions: string, tools: string, generation_allowance: string, context_bytes: string };
type WireSession = { id: string, workspace: string, title: string, next_event: string,
    first_user: string, summary_event: string, summary_through: string, pending: string, ledger: WireLedger };
type WireEvent = { role: string, name: string, call: string, chunks: string, complete: bool };
type WireCopy = { id: string, workspace: string, title: string, kind: string, source: string,
    digest: Array<u8>, total: string, cursor: string, phase: string };
type WireAttempt = { id: string, session: string, kind: string, label: string, phase: string,
    input_event: string, through: string, result_event: string, recovery_event: string };
type WireCache = { digest: Array<u8>, session: string, result_event: string };
type WireJournal = { id: string, session: string, name: string, call: string, phase: string,
    steps: string, message: string, owner_call: string, owner_name: string };
type WireOption = { tag: string, values: Array<string> };
type WireOutput = { job: string, call: string, phase: string, exit_code: WireOption,
    stdout: string, stderr: string, stdout_bytes: Array<u8>, stderr_bytes: Array<u8> };

flow decode<T>(text: string) -> T {
    let json = match parse(text) { Ok(value) => value, Err(_) => abort("native migration packet is not JSON"), };
    let typed: Option<Message<T>> = Message.new(json).cast<T>();
    return match typed { Some(value) => value.body, None() => abort("native migration packet has an invalid stored value"), };
}
flow integer(text: string) -> i64 {
    return match parse_i64(text) { Ok(value) => value, Err(_) => abort("native migration i64 is invalid"), };
}
flow size(text: string) -> usize {
    return match parse_usize(text) { Ok(value) => value, Err(_) => abort("native migration usize is invalid"), };
}
flow session(value: WireSession) -> Session {
    let old = value.ledger;
    let ledger = Ledger { turns = integer(old.turns), compactions = integer(old.compactions),
        tools = integer(old.tools), generation_allowance = integer(old.generation_allowance), context_bytes = size(old.context_bytes) };
    return Session { id = value.id, workspace = value.workspace, title = value.title,
        next_event = integer(value.next_event), first_user = integer(value.first_user),
        summary_event = integer(value.summary_event), summary_through = integer(value.summary_through), pending = value.pending, ledger };
}
flow event(value: WireEvent) -> Event {
    return Event { role = value.role, name = value.name, call = integer(value.call), chunks = size(value.chunks), complete = value.complete };
}
flow copy(value: WireCopy) -> CopyJob {
    return CopyJob { id = value.id, workspace = value.workspace, title = value.title, kind = value.kind, source = value.source,
        digest = from_array(value.digest), total = integer(value.total), cursor = integer(value.cursor), phase = value.phase };
}
flow attempt(value: WireAttempt) -> Attempt {
    return Attempt { id = value.id, session = value.session, kind = value.kind, label = value.label, phase = value.phase,
        input_event = integer(value.input_event), through = integer(value.through), result_event = integer(value.result_event), recovery_event = integer(value.recovery_event) };
}
flow journal(value: WireJournal) -> Journal {
    return Journal { id = value.id, session = value.session, name = value.name, call = integer(value.call), phase = value.phase,
        steps = integer(value.steps), message = value.message, owner_call = integer(value.owner_call), owner_name = value.owner_name };
}
flow exit_code(value: WireOption) -> Option<i32> ![Error<IndexError>] {
    if value.tag == "None" && value.values.len() == 0 { return None(); }
    if value.tag != "Some" || value.values.len() != 1 { abort("native migration exit code has an invalid option" ); }
    return Some(match parse_i32(value.values[0]) { Ok(value) => value, Err(_) => abort("native migration exit code is invalid"), });
}
flow output(value: WireOutput) -> JobEvent ![Error<IndexError>] {
    return JobEvent { job = value.job, call = integer(value.call), phase = value.phase, exit_code = exit_code(value.exit_code),
        stdout = value.stdout, stderr = value.stderr, stdout_bytes = from_array(value.stdout_bytes), stderr_bytes = from_array(value.stderr_bytes) };
}
flow record(row: WireRow) -> NativeRecord ![Error<IndexError>] {
    let key = row.key;
    return match row.store {
        "conversations.Counters" => NativeRecord.Counter(key, integer(decode<string>(row.value))),
        "conversations.Selected" => NativeRecord.Selected(key, decode<string>(row.value)),
        "conversations.Sessions" => NativeRecord.Session(key, session(decode<WireSession>(row.value))),
        "conversations.Events" => NativeRecord.Event(key, event(decode<WireEvent>(row.value))),
        "conversations.Chunks" => NativeRecord.Chunk(key, decode<string>(row.value)),
        "copies.Jobs" => NativeRecord.Copy(key, copy(decode<WireCopy>(row.value))),
        "attempts.Counter" => NativeRecord.AttemptCounter(key, integer(decode<string>(row.value))),
        "attempts.Attempts" => NativeRecord.Attempt(key, attempt(decode<WireAttempt>(row.value))),
        "configuration.Parsed" => {
            let value = decode<WireCache>(row.value);
            NativeRecord.Configuration(key, Cached { digest = from_array(value.digest), session = value.session, result_event = integer(value.result_event) })
        },
        "projects.Recent" => NativeRecord.Projects(key, decode<Array<string>>(row.value)),
        "mutations.Journals" => NativeRecord.Journal(key, journal(decode<WireJournal>(row.value))),
        "mutations.Steps" => NativeRecord.Step(key, decode<Step>(row.value)),
        "processes.Jobs" => NativeRecord.Job(key, decode<Job>(row.value)),
        "processes.Outputs" => NativeRecord.Output(key, output(decode<WireOutput>(row.value))),
        _ => abort("unsupported native migration store: " + row.store),
    };
}

public type LegacyNativePacket = {};
impl LegacyNativePacket ~ NativeStateSource {
    flow load(self) -> NativeImage ![Fs.read<MigrationRoot>, Error<FileError>, Error<ReadLimitError>, Error<IndexError>] {
        let source = match path<MigrationRoot>("snapshot.json") { Ok(value) => value, Err(_) => abort("native migration packet path is unavailable"), };
        let text = match utf8_decode(read_bytes_limited(source, 536870912), Strict) {
            Ok(value) => value, Err(_) => abort("native migration packet is not UTF-8"),
        };
        let packet = decode<Packet>(text);
        if packet.format != "nomo-native-state-0135-v1" { abort("unsupported native migration packet format"); }
        return NativeImage { source_sha256 = packet.source_sha256, records = packet.rows.iter().map(row => record(row)).collect() };
    }
}
