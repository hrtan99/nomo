module nomo.bootstrap.work;

import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.ports.{WorkEditor, WorkTimeline, Pending, Summary};
import nomo.core.conversation.Event;
import nomo.entry.edit_coordinator.confirm_current;
import nomo.harness.edit_original.EditApplier;
import nomo.session.edit_operation.Binding;
import nomo.session.redaction.Policy;
import nomo.session.recoverable_chat_store.record_work;
import nomo.session.work_fact_events.capture;
import nomo.tools.edit_contract.{Selector, Prepared, Confirmed};
import nomo.tools.edit_file.{EditableRoot, WideEditFile, read_original_wide};

public type NativeWorkEditor = {};
impl NativeWorkEditor ~ WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<IndexError>] {
        return read_original_wide(path);
    }
    flow confirm(self, selected: Selector, prepared: Prepared) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>, Error<IndexError>] {
        return confirm_current(selected, prepared);
    }
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>] {
        return WideEditFile {}.apply(prepared);
    }
}

public type EventWorkTimeline = {};
impl EventWorkTimeline ~ WorkTimeline {
    flow enabled(self) -> bool ![] { return true; }
    flow capture(self, pending: Pending, confirmed: Confirmed, summary: Summary) -> Result<Array<Event>, string> ![Error<IndexError>] {
        return capture(pending, confirmed, summary);
    }
    flow save(self, id: string, records: Array<Event>, policy: Policy, binding: string) -> Result<bool, string> ![Memory, Error<StorageError>, Error<IndexError>] {
        return record_work(id, records, policy, binding);
    }
}

public flow native_editor() -> NativeWorkEditor { return NativeWorkEditor {}; }
public flow event_timeline() -> EventWorkTimeline { return EventWorkTimeline {}; }
