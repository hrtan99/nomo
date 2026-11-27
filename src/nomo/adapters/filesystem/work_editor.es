module nomo.adapters.filesystem.work_editor;

import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.ports.WorkEditor;
import nomo.domain.mutations.edit_contract.Prepared;
import nomo.tools.edit_file.EditableRoot;
import nomo.adapters.filesystem.legacy.edit_file.{WideEditFile, read_original_wide};

public type NativeWorkEditor = {};
impl NativeWorkEditor ~ WorkEditor {
    flow read_original(self, path: string) -> Result<string, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>] {
        return read_original_wide(path);
    }
    flow apply(self, prepared: Prepared) -> Result<bool, string> ![Fs.stat<EditableRoot>, Fs.read<EditableRoot>, Fs.atomic_replace<EditableRoot>, Error<FileError>, Error<IndexError>, Error<BudgetExceeded>] {
        return WideEditFile {}.apply(prepared);
    }
}
