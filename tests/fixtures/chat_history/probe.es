module app.chat_history_probe;

import std.io.println;
import nomo.session.chat_session_contract.{Session, fresh, invalid, begin, complete};
import nomo.session.chat_history.{load, save};
import app.chat_session_contract_probe.outcome;

public flow chat_history_probe(args: Array<string>) -> i32 ![Console, Memory, Error<StorageError>, Error<IndexError>, Error<IOError>] {
    if args[0] == "first" {
        match load() { Ok(None()) => {} _ => { abort("expected missing history"); } }
        match save(fresh(), None()) { Ok(_) => {} Err(_) => { abort("initial save failed"); } }
        let current = match load() { Ok(Some(value)) => value, _ => { abort("initial session missing"); } };
        let reserved = match begin(current.value, "first question") { Ok(value) => value, Err(_) => { abort("first reservation refused"); } };
        match save(reserved, Some(current)) { Ok(_) => {} Err(_) => { abort("reservation save failed"); } }
        println("FIRST_SAVED"); return 0;
    }
    if args[0] == "show" {
        let current = match load() { Ok(Some(value)) => value, _ => { abort("history missing"); } };
        if current.value.phase != "running" || current.value.pending != "first question" { abort("reservation changed across processes"); }
        match begin(current.value, "repeat") { Ok(_) => { abort("interrupted reservation repeated"); } Err(_) => {} }
        println("HISTORY_RELOADED"); return 0;
    }
    if args[0] == "replace" {
        let current = match load() { Ok(Some(value)) => value, _ => { abort("history missing"); } };
        match save(fresh(), Some(current)) { Ok(_) => { abort("running session reset accepted"); } Err(_) => {} }
        let next = match complete(current.value, outcome(1, "first question", "blue")) { Ok(value) => value, Err(_) => { abort("synthetic outcome refused"); } };
        match save(next, Some(current)) { Ok(_) => {} Err(_) => { abort("history update failed"); } }
        match save(next, Some(current)) { Ok(_) => { abort("stale version accepted"); } Err(_) => {} }
        let after = match load() { Ok(Some(value)) => value, _ => { abort("updated history missing"); } };
        if after.value != next || after.value.invocation.prior.answer != "blue" { abort("stale save altered history"); }
        println("STALE_REFUSED"); return 0;
    }
    if args[0] == "second-reserve" {
        let current = match load() { Ok(Some(value)) => value, _ => { abort("first result missing"); } };
        if current.value.invocation.prior.answer != "blue" { abort("first answer changed"); }
        let reserved = match begin(current.value, "second question") { Ok(value) => value, Err(_) => { abort("second reservation refused"); } };
        match save(reserved, Some(current)) { Ok(_) => {} Err(_) => { abort("second reservation not saved"); } }
        println("SECOND_RESERVED"); return 0;
    }
    if args[0] == "second-show" {
        let current = match load() { Ok(Some(value)) => value, _ => { abort("second reservation missing"); } };
        if current.value.phase != "running" || current.value.pending != "second question" || current.value.invocation.prior.answer != "blue" ||
            current.value.invocation.usage.calls != 3 { abort("second reservation or prior budget changed"); }
        match begin(current.value, "repeat") { Ok(_) => { abort("second reservation repeated"); } Err(_) => {} }
        println("SECOND_RELOADED"); return 0;
    }
    if args[0] == "second-complete" {
        let current = match load() { Ok(Some(value)) => value, _ => { abort("second reservation missing"); } };
        let next = match complete(current.value, outcome(2, "second question", "green")) { Ok(value) => value, Err(_) => { abort("second result refused"); } };
        match save(next, Some(current)) { Ok(_) => {} Err(_) => { abort("second result not saved"); } }
        println("SECOND_SAVED"); return 0;
    }
    if args[0] == "final" {
        let current = match load() { Ok(Some(value)) => value, _ => { abort("completed session missing"); } };
        if current.value.phase != "complete" || current.value.invocation.prior.answer != "green" ||
            current.value.invocation.usage.calls != 6 { abort("completed session changed"); }
        match begin(current.value, "third") { Ok(_) => { abort("completed session restarted"); } Err(_) => {} }
        println("FINAL_RELOADED"); return 0;
    }
    if args[0] == "invalid" {
        let origin = fresh();
        let wrong = Session { format = 9, phase = origin.phase, invocation = origin.invocation, last_request = "", pending = "" };
        if invalid(wrong) == "" { abort("unknown format accepted"); }
        match save(wrong, None()) { Ok(_) => { abort("invalid row saved"); } Err(_) => {} }
        println("INVALID_REFUSED"); return 0;
    }
    abort("unknown test action");
}
