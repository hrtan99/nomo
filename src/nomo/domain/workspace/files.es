module nomo.domain.workspace.files;

import nomo.domain.context.instructions.ProjectInstruction;

public type FileContent = { path: string, text: string, instructions: Array<ProjectInstruction> };
public type PathInfo = { path: string, is_file: bool, is_dir: bool, bytes: u64 };
public type MatchLine = { path: string, line: usize, text: string };
public type SearchRequest = { paths: Array<string>, literal: string };
