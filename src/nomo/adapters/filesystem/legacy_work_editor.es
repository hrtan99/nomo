module nomo.adapters.filesystem.legacy_work_editor;

import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.ports.WorkEditor;
import nomo.domain.mutations.edit_contract.Prepared;
import nomo.tools.edit_file.EditableRoot;
import nomo.adapters.filesystem.legacy.edit_file.{read_original, apply as apply_file};

public type LegacyWorkEditor = {};
impl LegacyWorkEditor ~ WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>] {
        return read_original(path);
    }
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>] {
        return apply_file(prepared);
    }
}

// Legacy work records do not own an event timeline. This port makes that
// absence explicit while the shared controller retains the common ordering.
