use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process,
};

use etas_host::{FilesystemPolicy, FilesystemSandbox, HostError, HostErrorCode, WorkspaceRoot};

struct Fixture {
    base: PathBuf,
}

impl Fixture {
    fn create() -> Self {
        let base = PathBuf::from(format!("/tmp/nomo-etas004-host-{}", process::id()));
        fs::create_dir_all(base.join("workspace")).expect("create workspace");
        fs::create_dir_all(base.join("outside/linked-dir")).expect("create outside workspace");
        Self { base }
    }

    fn workspace(&self) -> PathBuf {
        self.base.join("workspace")
    }

    fn outside(&self) -> PathBuf {
        self.base.join("outside")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::set_permissions(
            self.workspace().join("locked"),
            fs::Permissions::from_mode(0o700),
        );
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn expect_error<T>(result: Result<T, HostError>, code: HostErrorCode, message: &str) -> HostError {
    let error = match result {
        Ok(_) => panic!("operation should fail"),
        Err(error) => error,
    };
    assert_eq!(error.code, code, "unexpected error: {error:?}");
    assert!(
        error.message.contains(message),
        "unexpected error: {error:?}"
    );
    error
}

fn pass(name: &str, detail: &str) {
    println!("CASE {name}\nRESULT pass\nDETAIL {detail}\n");
}

fn main() {
    let fixture = Fixture::create();
    let workspace = fixture.workspace();
    let outside = fixture.outside();
    let root = WorkspaceRoot::new(&workspace).expect("canonical workspace root");
    let sandbox = FilesystemSandbox::new(FilesystemPolicy::allow_workspace(root.clone()));

    fs::write(workspace.join("input.txt"), b"ETAS004_READ_OK").expect("seed input");
    assert_eq!(
        sandbox
            .read_file(&root, Path::new("input.txt"))
            .expect("read file"),
        b"ETAS004_READ_OK"
    );
    pass("read_success", "bytes matched inside configured root");

    sandbox
        .atomic_write(&root, Path::new("output.txt"), b"ETAS004_WRITE_OK")
        .expect("atomic write");
    assert_eq!(
        fs::read(workspace.join("output.txt")).expect("read output"),
        b"ETAS004_WRITE_OK"
    );
    pass("write_success", "atomic write created the requested file");

    expect_error(
        sandbox.read_file(&root, Path::new("missing.txt")),
        HostErrorCode::InvalidRequest,
        "workspace path does not exist",
    );
    pass(
        "missing_path",
        "InvalidRequest; workspace path does not exist",
    );

    fs::write(workspace.join("unreadable.txt"), b"private").expect("seed unreadable file");
    fs::set_permissions(
        workspace.join("unreadable.txt"),
        fs::Permissions::from_mode(0o000),
    )
    .expect("remove file permissions");
    let permission_error = expect_error(
        sandbox.read_file(&root, Path::new("unreadable.txt")),
        HostErrorCode::ProviderUnavailable,
        "failed to read workspace file",
    );
    assert!(
        permission_error
            .details
            .iter()
            .any(|detail| detail.value.contains("Permission denied")),
        "permission diagnostic should preserve the OS denial: {permission_error:?}"
    );
    fs::set_permissions(
        workspace.join("unreadable.txt"),
        fs::Permissions::from_mode(0o600),
    )
    .expect("restore file permissions");
    pass(
        "permission_denial",
        "ProviderUnavailable; OS Permission denied retained in details",
    );

    expect_error(
        sandbox.read_file(&root, Path::new("../outside/secret.txt")),
        HostErrorCode::AuthorityDenied,
        "workspace path traversal is not allowed",
    );
    expect_error(
        sandbox.read_file(&root, &outside.join("secret.txt")),
        HostErrorCode::AuthorityDenied,
        "absolute workspace paths are not allowed",
    );
    pass(
        "path_escape",
        "parent traversal and absolute paths both returned AuthorityDenied",
    );

    fs::write(outside.join("secret.txt"), b"OUTSIDE_SECRET").expect("seed outside secret");
    symlink(outside.join("secret.txt"), workspace.join("leak.txt")).expect("create file symlink");
    expect_error(
        sandbox.read_file(&root, Path::new("leak.txt")),
        HostErrorCode::AuthorityDenied,
        "workspace path escapes the configured root",
    );
    symlink(outside.join("linked-dir"), workspace.join("linked-dir")).expect("create dir symlink");
    expect_error(
        sandbox.atomic_write(&root, Path::new("linked-dir/pwned.txt"), b"blocked"),
        HostErrorCode::AuthorityDenied,
        "workspace path escapes the configured root",
    );
    assert!(!outside.join("linked-dir/pwned.txt").exists());
    pass(
        "symbolic_link",
        "outside read and directory-write symlink escapes were denied",
    );

    let locked = workspace.join("locked");
    fs::create_dir(&locked).expect("create locked directory");
    fs::write(locked.join("target.txt"), b"BEFORE").expect("seed atomic target");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).expect("lock directory");
    expect_error(
        sandbox.atomic_write(&root, Path::new("locked/target.txt"), b"AFTER"),
        HostErrorCode::ProviderUnavailable,
        "failed to create temporary workspace file",
    );
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).expect("unlock directory");
    assert_eq!(
        fs::read(locked.join("target.txt")).expect("read preserved target"),
        b"BEFORE"
    );
    assert!(
        fs::read_dir(&locked)
            .expect("list locked directory")
            .all(|entry| !entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .contains(".etas-tmp-")),
        "failed atomic write must not leave a temporary artifact"
    );
    pass(
        "atomic_failure",
        "destination stayed byte-identical and no temporary file remained",
    );

    let deny = FilesystemSandbox::new(FilesystemPolicy::deny_all());
    expect_error(
        deny.read_file(&root, Path::new("input.txt")),
        HostErrorCode::AuthorityDenied,
        "filesystem read is not allowed",
    );
    pass(
        "authority_denial",
        "deny-all policy rejected an otherwise valid in-root read",
    );

    println!("ETAS-004 host boundary matrix passed: 8 cases");
}
