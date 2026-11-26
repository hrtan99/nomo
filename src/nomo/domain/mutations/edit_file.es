module nomo.domain.mutations.edit_file;



public type EditLimit = { bytes: usize, metadata: u64 };

public type FileInfo = { is_file: bool, is_dir: bool, len: u64 };
