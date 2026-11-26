module nomo.domain.context.workspace;



// Discovery is bounded and rooted in the currently selected read-only region.
public type DiscoveredFileInfo = { is_file: bool, is_dir: bool, len: u64 };

public type Discovery = { files: Array<string>, page: usize, more: bool };
