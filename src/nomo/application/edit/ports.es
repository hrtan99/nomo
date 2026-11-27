module nomo.application.edit.ports;

import std.io.IOError as ConsoleError;
import nomo.application.edit.effects.Approval;
import nomo.session.edit_operation.Binding;

public type Preview = { binding: Binding, machine: string, diff: string };

public spec PreviewPresenter {
    flow present(self, preview: Preview) -> unit ![Console, Error<ConsoleError>];
}

public spec CurrentEditConsent {
    flow confirm(self, preview: Preview) -> Result<Binding, string> ![Console, Approval, Error<ConsoleError>];
}
