module app.contract_probe;
import std.io.println;
import nomo.entry.user_context_entry.selection;
import nomo.entry.harness_work_entry.{chain_ledger, user_context_ledger, Pending, Failure, Completed, Summary, prepare_chain_work, summarize_chain};
import nomo.cli.harness_work_args.Work;
import nomo.harness.work_chain_context.ParentFacts;
import nomo.harness.harness_work_contract.fresh;
import nomo.session.work_chain_usecase.{WorkStop, WorkOutcome};
import nomo.session.work_chain.{initial_user_context, turn_caps};
import nomo.session.work_chain_selection.{Snapshot, ObservedRow, ObservedJournal, Selector, validate as selection_error, eligible, select};
import nomo.session.work_chain_journal_contract.CapturedJournal;
import nomo.tools.edit_file.prepare_original;
import nomo.tools.edit_binding.bind;
import nomo.entry.work_chain_entry.{DetailedWorkOutcome, present_detailed_outcome, project_outcome};

flow base(root: string, mode: string) -> Array<string> {
    return ["--read-root", root, "--input-mode", mode, "--id", "user-1", "--workspace", "demo", "--path", "demo/value.txt", "--once", "Read the selected file", "--allow", "notes/context.txt"];
}
flow accepted(args: Array<string>, root: string) -> bool {
    return match selection(args) { Ok(value) => value.root == root && value.input.work.allowed == ["notes/context.txt"], Err(_) => false };
}
flow refused(args: Array<string>) -> bool { return match selection(args) { Ok(_) => false, Err(_) => true }; }
flow graph_guard() -> bool {
    let row = match initial_user_context("root", "owned", "demo/value.txt", "read context", ["notes/context.txt"], turn_caps()) { Ok(value) => value, Err(_) => { return false; } };
    let observed = ObservedRow { key = "turn:1", version = "v1", value = row };
    let plain = Snapshot { root = Some(observed), child = None(), root_journal = None(), child_journal = None() };
    let child = Snapshot { root = Some(observed), child = Some(observed), root_journal = None(), child_journal = None() };
    let prepared = match prepare_original("demo/value.txt", "old", "old", "new") { Ok(value) => value, Err(_) => { return false; } };
    let binding = match bind("child", "owned", "demo/value.txt", prepared) { Ok(value) => value, Err(_) => { return false; } };
    let journal = ObservedJournal { key = "turn:2", version = "v2", value = CapturedJournal { format = 2, chain = "root", turn = 2, phase = "intent", binding = binding } };
    let orphan = Snapshot { root = Some(observed), child = None(), root_journal = None(), child_journal = Some(journal) };
    let refused_parent = match select(plain, "owned", "demo/value.txt", Selector.Parent) { Ok(_) => false, Err(_) => true };
    return selection_error(plain, "owned", "demo/value.txt") == "" && !eligible(plain, "owned", "demo/value.txt") && refused_parent &&
        selection_error(child, "owned", "demo/value.txt") == "user-context work cannot have a successor or second journal" &&
        selection_error(orphan, "owned", "demo/value.txt") == "user-context work cannot have a successor or second journal";
}
public flow pure_probe() -> bool {
    let tty = base("/tmp/资料", "tty"); let pipe = base("/tmp/root", "non-tty");
    return graph_guard() && accepted(tty, "/tmp/资料") && accepted(pipe.push("--accept-read-root"), "/tmp/root") &&
        refused(pipe) && refused(tty.push("--accept-read-root")) && refused(pipe.push("--accept-read-root").push("--accept-read-root")) &&
        refused(base("relative", "tty")) && refused(base("/tmp/\nunsafe", "tty")) && refused(base("/tmp/root", "unknown")) &&
        refused(tty.push("--read-root").push("/tmp/other")) && refused(tty.push("--workspace").push("other")) &&
        refused(["--read-root", "/tmp/root", "--input-mode", "tty", "--id", "user-1", "--workspace", "demo", "--path", "other.txt", "--once", "Read", "--allow", "notes/context.txt"]) &&
        refused(["--read-root", "/tmp/root", "--input-mode", "tty", "--id", "user-1", "--workspace", "demo", "--path", "demo/value.txt", "--once", "Read", "--allow", "../outside"]);
}
public flow observe(args: Array<string>) -> i32 {
    if !pure_probe() { abort("user-context selection contract failed"); }
    println("PASS user-context selection and consent options"); return 0;
}
public flow old_ledger(args: Array<string>) -> i32 { chain_ledger(fresh()); return 0; }
public flow user_ledger(args: Array<string>) -> i32 { user_context_ledger(fresh()); return 0; }

public flow old_outcome(args: Array<string>) -> i32 {
    let stop = WorkStop { state = fresh(), error = "same diagnostic" };
    if project_outcome(DetailedWorkOutcome.Stopped(stop)) != WorkOutcome.Stopped(stop) { abort("old projection changed"); }
    let status = present_detailed_outcome(DetailedWorkOutcome.Stopped(stop));
    if status != 1 { abort("old refusal status changed"); } return 0;
}
public flow user_outcome(args: Array<string>) -> i32 {
    let stop = WorkStop { state = fresh(), error = "same diagnostic" };
    if project_outcome(DetailedWorkOutcome.UserContextStopped(stop)) != WorkOutcome.Stopped(stop) { abort("user projection changed"); }
    let status = present_detailed_outcome(DetailedWorkOutcome.UserContextStopped(stop));
    if status != 1 { abort("user refusal status changed"); } return 0;
}

// Compile-time compatibility checks for callers of the existing public APIs.
public flow old_prepare_signature(input: Work, parent: Array<ParentFacts>, expected: Option<string>, inspect_plan: bool, inspect_all: bool) -> Result<Pending, Failure> {
    return prepare_chain_work(input, parent, expected, inspect_plan, inspect_all);
}
public flow old_summary_signature(completed: Completed, parent: Array<ParentFacts>, inspect_all: bool) -> Result<Summary, Failure> {
    return summarize_chain(completed, parent, inspect_all);
}
