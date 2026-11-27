module nomo.application.workspace.service;

import std.text.{lines, contains};
import nomo.application.workspace.ports.ProjectFileSource;
import nomo.application.context.ports.InstructionReader;
import nomo.application.conversation.ports.ConversationWriter;
import nomo.domain.serialization.json.encode;
import nomo.domain.workspace.files.{FileContent, PathInfo, MatchLine, SearchRequest};
import nomo.domain.context.instructions.ProjectInstruction;

flow record<H ~ ConversationWriter, T>(history: H, session: string, role: string, name: string, value: T, call: i64) -> i64 {
    let text = match encode(value, "history conversion failed", "history encoding failed") {
        Ok(value) => value, Err(error) => abort(error),
    };
    return history.append(session, role, name, text, call);
}

// Observations remain available while a mutating request awaits recovery.
// Record the request before IO; publish only the result that actually returned.
public flow read<H ~ ConversationWriter, F ~ ProjectFileSource, G ~ InstructionReader>(history: H, files: F, guidance: G, session: string, path: string) -> FileContent {
    let call = record(history, session, "observation_call", "read_file", path, -1);
    let result = FileContent { path, text = files.text(path), instructions = guidance.read(path) };
    record(history, session, "tool", "read_file", result, call);
    return result;
}

public flow instructions<H ~ ConversationWriter, G ~ InstructionReader>(history: H, guidance: G, session: string, path: string) -> Array<ProjectInstruction> {
    let call = record(history, session, "observation_call", "project_instructions", path, -1);
    let result = guidance.read(path);
    record(history, session, "tool", "project_instructions", result, call);
    return result;
}

public flow list<H ~ ConversationWriter, F ~ ProjectFileSource>(history: H, files: F, session: string, path: string) -> Array<PathInfo> {
    let call = record(history, session, "observation_call", "list_directory", path, -1);
    let result = files.entries(path);
    record(history, session, "tool", "list_directory", result, call);
    return result;
}

public flow stat<H ~ ConversationWriter, F ~ ProjectFileSource>(history: H, files: F, session: string, path: string) -> PathInfo {
    let call = record(history, session, "observation_call", "stat_file", path, -1);
    let result = files.metadata(path);
    record(history, session, "tool", "stat_file", result, call);
    return result;
}

public flow search<H ~ ConversationWriter, F ~ ProjectFileSource>(history: H, files: F, session: string, paths: Array<string>, literal: string) -> Array<MatchLine> {
    let call = record(history, session, "observation_call", "search_files", SearchRequest { paths, literal }, -1);
    var matches: Array<MatchLine> = [];
    for path in paths {
        var number: usize = 1;
        for line in lines(files.text(path)) {
            if contains(line, literal) { matches = matches.push(MatchLine { path, line = number, text = line }); }
            number = number + 1;
        }
    }
    record(history, session, "tool", "search_files", matches, call);
    return matches;
}
