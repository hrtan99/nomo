module nomo.application.workspace.ports;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.domain.workspace.files.{FileContent, PathInfo, MatchLine};
import nomo.domain.context.instructions.ProjectInstruction;

public spec ProjectFileSource {
    flow text(self, path: string) -> string ![Fs.read<ProjectRoot>, Error<FileError>, Error<ReadLimitError>];
    flow entries(self, path: string) -> Array<PathInfo> ![Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Error<FileError>, Error<BudgetExceeded>];
    flow metadata(self, path: string) -> PathInfo ![Fs.stat<ProjectRoot>, Error<FileError>];
}

public effect WorkspaceObservations {
    action read(session: string, path: string) -> FileContent;
    action instructions(session: string, path: string) -> Array<ProjectInstruction>;
    action list(session: string, path: string) -> Array<PathInfo>;
    action stat(session: string, path: string) -> PathInfo;
    action search(session: string, paths: Array<string>, literal: string) -> Array<MatchLine>;
}
