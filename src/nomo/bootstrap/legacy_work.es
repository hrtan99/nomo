module nomo.bootstrap.legacy_work;

import std.io.println;
import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.ports.{WorkEditor, WorkTimeline, Pending, Summary};
import nomo.application.work_output.WorkOutputSink;
import nomo.core.conversation.Event;
import nomo.entry.edit_coordinator.confirm_current;
import nomo.entry.edit_context.{display, recorded};
import nomo.application.harness.work.controller.historical_ledger_text;
import nomo.harness.harness_work_contract.Ledger;
import nomo.session.edit_operation.Binding;
import nomo.session.redaction.Policy;
import nomo.tools.edit_contract.{Selector, Prepared, Confirmed};
import nomo.tools.edit_file.{EditableRoot, read_original, apply as apply_file};

public type LegacyWorkEditor = {};
impl LegacyWorkEditor ~ WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<IndexError>] {
        return read_original(path);
    }
    flow confirm(self, selected: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>, Error<IndexError>] {
        return confirm_current(selected, prepared);
    }
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>] {
        return apply_file(prepared);
    }
}

// Legacy work records do not own an event timeline. This port makes that
// absence explicit while the shared controller retains the common ordering.
public type LegacyWorkTimeline = {};
impl LegacyWorkTimeline ~ WorkTimeline {
    flow enabled(self) -> bool ![] { return false; }
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>] { return Err("legacy work has no event timeline"); }
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] { return Err("legacy work has no event timeline"); }
}

public type LegacyWorkOutput = {};
impl LegacyWorkOutput ~ WorkOutputSink {
    flow progress(self, line: string) -> unit ![Error<ConsoleError>] {
        if line != "POST_EDIT context" && line != "POST_EDIT aggregate" && line != "POST_EDIT events" && line != "POST_EDIT persist" { println(line); }
    }
    flow diagnostic(self, line: string) -> unit ![Error<ConsoleError>] { println(line); }
    flow recorded(self, selected: Selector) -> unit ![Error<ConsoleError>, Error<IndexError>] { recorded(selected); }
    flow ledger(self, state: Ledger, wide: bool, high_input: bool) -> unit ![Error<ConsoleError>] {
        println(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
    }
    flow refused(self, error: string) -> i32 ![Error<ConsoleError>] { println("REFUSED " + error); return 1; }
    flow completed(self, answer: string, saved: string, state: Ledger, wide: bool, high_input: bool) -> i32 ![Error<ConsoleError>, Error<IndexError>] {
        display("FINAL ", answer);
        println(saved);
        println(historical_ledger_text(state) + "; configured allowances are not measured usage; no persisted Model history or mutating resume");
        return 0;
    }
}

public flow legacy_editor() -> LegacyWorkEditor { return LegacyWorkEditor {}; }
public flow legacy_timeline() -> LegacyWorkTimeline { return LegacyWorkTimeline {}; }
public flow legacy_output() -> LegacyWorkOutput { return LegacyWorkOutput {}; }
