module nomo.adapters.filesystem.instruction_tools;

import std.fs.{ReadLimitError, IOError as FileError};
import std.effects.Fs;
import nomo.native.workspace.ProjectRoot;
import nomo.application.conversation.session_context.SessionContext;
import nomo.adapters.storage.conversations.{observe_started, observe_finished};
import nomo.application.instructions.ports.ProjectInstructions;
public import nomo.domain.context.instructions.ProjectInstruction;

public flow load_instructions(pathname: string) -> Array<ProjectInstruction> ![ProjectInstructions, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<FileError>, Error<ReadLimitError>] {
    return perform ProjectInstructions.read(pathname);
}

/// Read applicable project guidance before creating or changing a file. More specific scopes refine ancestor guidance; these files do not grant permission to execute operations.
public tool project_instructions(pathname: string) -> Array<ProjectInstruction>
    ![SessionContext, ProjectInstructions, Memory, Fs.read<ProjectRoot>, Fs.list<ProjectRoot>, Error<StorageError>, Error<MemoryConflict>, Error<FileError>, Error<ReadLimitError>] {
    let call = observe_started("project_instructions", pathname);
    let result = load_instructions(pathname);
    observe_finished("project_instructions", call, result);
    return result;
}
