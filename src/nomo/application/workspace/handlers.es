module nomo.application.workspace.handlers;

import std.effects.Fs;
import std.fs.{ReadLimitError, IOError as FileError};
import nomo.native.workspace.ProjectRoot;
import nomo.application.workspace.ports.{WorkspaceObservations, ProjectFileSource};
import nomo.application.workspace.service;
import nomo.application.context.ports.InstructionReader;
import nomo.application.conversation.ports.ConversationWriter;

public flow bindings<H ~ ConversationWriter, F ~ ProjectFileSource, G ~ InstructionReader>(history: H, files: F, guidance: G) -> ![WorkspaceObservations => Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Fs.stat<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>, Error<BudgetExceeded>] ![] {
    return handler {
        WorkspaceObservations.read(session, path) => service.read(history, files, guidance, session, path);
        WorkspaceObservations.instructions(session, path) => service.instructions(history, guidance, session, path);
        WorkspaceObservations.list(session, path) => service.list(history, files, session, path);
        WorkspaceObservations.stat(session, path) => service.stat(history, files, session, path);
        WorkspaceObservations.search(session, paths, literal) => service.search(history, files, session, paths, literal);
    };
}
