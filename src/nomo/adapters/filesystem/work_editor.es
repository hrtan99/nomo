module nomo.adapters.filesystem.work_editor;

import std.io.IOError as ConsoleError;
import std.fs.IOError as FileError;
import std.effects.Fs;
import nomo.application.work.ports.WorkEditor;
import nomo.adapters.cli.legacy.edit_coordinator.confirm_current;
import nomo.session.edit_operation.Binding;
import nomo.domain.mutations.edit_contract.{Selector, Prepared};
import nomo.tools.edit_file.EditableRoot;
import nomo.adapters.filesystem.legacy.edit_file.{WideEditFile, read_original_wide};

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
