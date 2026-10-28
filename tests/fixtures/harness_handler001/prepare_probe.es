module app.handler_prepare_probe;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import std.bytes.len as byte_count;
import std.codec.text.utf8_encode;
import std.json.{JsonValue, stringify};
import std.agent.message.Message;
import nomo.cli.harness_work_args.parse;
import nomo.entry.harness_work_entry.{prepare_work, ledger};
import nomo.tools.edit_proposal.validate;
import nomo.tools.workspace.ReadOnlyRoot;
import nomo.tools.edit_file.EditableRoot;

// Production composition only: no source Model handler, admission, execution,
// summary or synthetic completion. The input supplies no file contents.
public flow observe(args: Array<string>) -> i32 ![Console, Fs.read<ReadOnlyRoot>, Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    let input = match parse(args) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    if input.edit.help { println("REFUSED prepare component requires explicit selectors and task"); return 1; }
    let pending = match prepare_work(input) {
        Ok(value) => value,
        Err(failure) => { println("REFUSED " + failure.error); ledger(failure.state); return 1; }
    };
    match validate(pending.prepared.request, pending.prepared.proposal) {
        Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; }
    }
    // Observe the complete actual Pending. This is not a replacement record
    // comparator or a change to the original E17 full-record-equality oracle.
    let message = Message.new(pending);
    let converted: Option<Message<JsonValue>> = message.cast<JsonValue>();
    let body = match converted { Some(value) => value.body, None() => { abort("Pending JSON projection failed"); } };
    let encoded = match stringify(body) { Ok(value) => value, Err(_) => { abort("Pending JSON encoding failed"); } };
    if byte_count(utf8_encode(encoded)) > 65536 { abort("Pending observation exceeds 65536 bytes"); }
    println("PENDING " + encoded);
    ledger(pending.state);
    println("PREPARE_ONLY no admission, journal, approval, atomic write or completed edit");
    return 0;
}
