module app.multifile;

import std.io.println;
import nomo.tools.workspace.search_files;
import nomo.model.tool_context.allowed_error;
import nomo.model.read_protocol.decode_child;
import nomo.session.harness_checkpoint.{Identity, identity_error};
import nomo.cli.harness_work_args.{parse_unicode, parse as parse_legacy};
import nomo.harness.harness_work_contract.{Evidence, evidence_error};
import nomo.harness.harness_tool_contract.Ledger;
import nomo.tools.edit_file.prepare_original;
import nomo.tools.edit_binding.bind;
import nomo.session.work_record.partial;

flow search_probe(args: Array<string>) -> i32 {
    let allowed = ["a.txt", "b.txt", "c.txt", "d.txt"];
    let work_args = ["--id", "edit", "--workspace", "workspace", "--path", "note.txt", "--once", "task", "--allow", "a.txt,b.txt,c.txt,d.txt"];
    match parse_unicode(work_args) { Ok(item) => { if item.allowed != allowed { abort("work allowlist changed"); } } Err(_) => { abort("four-file work refused"); } }
    match parse_legacy(work_args) { Ok(_) => { abort("legacy work accepted four"); } Err(_) => {} }
    if allowed_error(allowed) != "" || allowed_error(["a.txt"]) != "" || allowed_error(["a.txt", "b.txt"]) != "" { abort("valid allowlist refused"); }
    if allowed_error(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) == "" { abort("five allowed"); }
    if allowed_error(["a.txt", "a.txt", "c.txt", "d.txt"]) == "" || allowed_error(["a.txt", "b.txt", "a.txt", "d.txt"]) == "" ||
       allowed_error(["a.txt", "b.txt", "c.txt", "a.txt"]) == "" || allowed_error(["a.txt", "b.txt", "b.txt", "d.txt"]) == "" ||
       allowed_error(["a.txt", "b.txt", "c.txt", "b.txt"]) == "" || allowed_error(["a.txt", "b.txt", "c.txt", "c.txt"]) == "" { abort("duplicate allowed"); }
    let raw = "[\"search\",\"needle\",\"a.txt\",\"b.txt\",\"c.txt\",\"d.txt\"]";
    let selected = match decode_child(raw, allowed, false) { Ok(item) => item, Err(_) => abort("four-file action refused") };
    if selected.files != allowed { abort("selected files changed"); }
    match decode_child("[\"search\",\"needle\",\"a.txt\",\"b.txt\",\"c.txt\",\"e.txt\"]", allowed, false) { Ok(_) => abort("unapproved file"), Err(_) => {} }
    match decode_child("[\"search\",\"needle\",\"a.txt\",\"b.txt\",\"a.txt\"]", allowed, false) { Ok(_) => abort("duplicate selection"), Err(_) => {} }
    let full = search_files(allowed, "needle");
    if full.status != "complete" || full.scanned != 4096 || full.text != "d.txt:1\n" { abort("four-file exact scan"); }
    let excess = search_files(["a.txt", "b.txt", "c.txt", "e.txt"], "needle");
    if excess.status != "refused" || excess.scanned != 3072 || excess.text != "e.txt: file exceeds remaining scan allowance" { abort("total scan overflow"); }
    let empty = search_files(["wide.txt", "a.txt", "b.txt", "empty.txt"], "needle");
    if empty.status != "complete" || empty.scanned != 4096 || empty.text != "" { abort("empty file at budget boundary"); }
    let invalid = search_files(["a.txt", "invalid.txt"], "needle");
    if invalid.status != "unsupported" || invalid.scanned != 1024 || invalid.text != "invalid.txt: file is not UTF-8" { abort("invalid UTF-8 accounting"); }
    let duplicate = search_files(["a.txt", "b.txt", "c.txt", "b.txt"], "needle");
    if duplicate.status != "refused" || duplicate.scanned != 0 { abort("duplicate search dispatched"); }
    let old = Identity { id = "old", workspace = "workspace", allowed = ["a.txt", "b.txt"] };
    let newer = Identity { id = "old", workspace = "workspace", allowed = allowed };
    if identity_error(old) != "" || identity_error(newer) == "" { abort("legacy identity compatibility"); }
    let evidence = Evidence { request = "task", task = "search", operation = "search", files = allowed, literal = "needle",
        outcome = "complete: d.txt:1<LF>", result = "found", summary = "found", allowed = allowed,
        ledger = Ledger { steps = 7, calls = 4, tokens = 8192, tools = 1, scan = 4096 } };
    if evidence_error(evidence) != "" { abort("four-file evidence refused"); }
    let prepared = match prepare_original("note.txt", "before old\n", "old", "new") { Ok(item) => item, Err(_) => abort("edit setup") };
    let binding = match bind("edit", "workspace", "note.txt", prepared) { Ok(item) => item, Err(_) => abort("binding setup") };
    match partial(binding, evidence, "edit task", prepared) { Ok(_) => abort("legacy work record dropped files"), Err(_) => {} }
    let old_evidence = Evidence { request = evidence.request, task = evidence.task, operation = evidence.operation,
        files = ["a.txt", "b.txt"], literal = evidence.literal, outcome = evidence.outcome, result = evidence.result,
        summary = evidence.summary, allowed = ["a.txt", "b.txt"], ledger = evidence.ledger };
    match partial(binding, old_evidence, "edit task", prepared) { Ok(_) => {} Err(_) => abort("legacy two-file work refused") }
    println("PASS bounded multifile search and legacy identity"); return 0;
}

flow missing_probe(args: Array<string>) -> i32 {
    let result = search_files(["a.txt", "missing.txt", "d.txt"], "needle");
    println("UNEXPECTED " + result.status); return 0;
}
