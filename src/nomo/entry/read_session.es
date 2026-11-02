module nomo.entry.read_session;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.tools.workspace.ReadOnlyRoot;
import std.text.{len, split, to_string_i32};
import std.collections.len as count;
import nomo.model.model_tool_contract.allowed_error;
import nomo.model.read_protocol.question_error;
import nomo.harness.read_tool_chat.run_turn;
import nomo.session.chat_session_contract.{fresh, begin, complete};
import nomo.session.chat_history.{load, save};

// Each entry requires an independently selected current read root and grant.
// Saved conversation is untrusted context; a running reservation never resumes.
public flow run(args: Array<string>) -> i32 ![Console, Memory, Fs.read<ReadOnlyRoot>, Error<StorageError>, Error<IndexError>, Error<ConsoleError>, Error<FileError>] {
    if count(args) != 5 || (args[0] != "new" && args[0] != "continue") || args[1] != "--allow" || args[3] != "--once" {
        println("REFUSED expected new|continue --allow FILE[,FILE] --once QUESTION"); return 1;
    }
    if len(args[2]) > 97 { println("REFUSED allowlist too long"); return 1; }
    let allowed = split(args[2], ",");
    let paths = allowed_error(allowed); if paths != "" { println("REFUSED " + paths); return 1; }
    let request = args[4]; let question = question_error(request); if question != "" { println("REFUSED " + question); return 1; }
    let existing = match load() { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    if args[0] == "new" {
        match existing { Some(_) => { println("REFUSED session already exists"); return 1; } None() => {} }
        match save(fresh(), None()) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    } else {
        match existing { None() => { println("REFUSED session missing"); return 1; } Some(_) => {} }
    }
    let current = match load() { Ok(Some(value)) => value, _ => { println("REFUSED session missing or invalid"); return 1; } };
    let running = match begin(current.value, request) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let version = match save(running, Some(current)) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    let reserved = match load() { Ok(Some(value)) => value, _ => { println("REFUSED reservation missing"); return 1; } };
    if reserved.value != running || reserved.version.opaque != version.opaque { println("REFUSED reservation changed"); return 1; }
    println("RESERVED chat turn; interruption leaves it unresolved and will not retry.");
    println("A final answer is provisional until SAVED confirms durable history.");
    let result = run_turn(request, allowed, running.invocation);
    if result.status != 0 || !result.resolved { println("REFUSED chat turn unresolved; inspect session, do not retry"); return 1; }
    let next = match complete(running, result) { Ok(value) => value, Err(error) => { println("REFUSED " + error); return 1; } };
    match save(next, Some(reserved)) { Ok(_) => {} Err(error) => { println("REFUSED " + error); return 1; } }
    println("SAVED chat history; prior data is not a grant or workspace identity."); return 0;
}

// Status is recorded data only. It performs no model or workspace action.
public flow status(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<ConsoleError>] {
    if count(args) != 0 { println("REFUSED status takes no arguments"); return 1; }
    let entry = match load() { Ok(Some(value)) => value, Ok(None()) => { println("SESSION missing"); return 1; } Err(error) => { println("REFUSED " + error); return 1; } };
    let saved = entry.value;
    println("SESSION " + saved.phase + " turns=" + to_string_i32(saved.invocation.admitted));
    println("Recorded data only; this does not establish current workspace identity, authorization or a remote outcome.");
    return 0;
}
