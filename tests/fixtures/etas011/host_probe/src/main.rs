// ETAS-011 candidate diagnostics; the ETAS-004 baseline probe stays unchanged.
use etas_host::{FilesystemPolicy, FilesystemSandbox, HostError, HostErrorCode, TestWorkspace};
use std::{fs, os::unix::fs::PermissionsExt, path::Path};

fn denied<T>(result: Result<T, HostError>, code: HostErrorCode, message: &str) {
    let error = result.err().expect("operation must fail");
    assert_eq!(error.code, code, "{error:?}");
    assert_eq!(error.message, message, "{error:?}");
}

fn main() {
    let fixture = TestWorkspace::create("nomo-etas011-file").unwrap();
    let other = TestWorkspace::create("nomo-etas011-other").unwrap();
    let root = fixture.root().unwrap();
    let sandbox = FilesystemSandbox::new(FilesystemPolicy::allow_workspace(root.clone()));
    let capability_error = "workspace capability operation failed";
    fs::write(fixture.path().join("input"), b"input").unwrap();
    assert_eq!(
        sandbox.read_file(&root, Path::new("input")).unwrap(),
        b"input"
    );
    println!("PASS read_success");

    sandbox
        .atomic_write(&root, Path::new("output"), b"output")
        .unwrap();
    assert_eq!(fs::read(fixture.path().join("output")).unwrap(), b"output");
    println!("PASS write_success");

    denied(
        sandbox.read_file(&root, Path::new("missing")),
        HostErrorCode::InvalidRequest,
        capability_error,
    );
    println!("PASS missing_path");

    let input = fixture.path().join("input");
    fs::set_permissions(&input, fs::Permissions::from_mode(0o000)).unwrap();
    denied(
        sandbox.read_file(&root, Path::new("input")),
        HostErrorCode::AuthorityDenied,
        capability_error,
    );
    fs::set_permissions(&input, fs::Permissions::from_mode(0o600)).unwrap();
    println!("PASS permission_denial");

    denied(
        sandbox.read_file(&root, Path::new("../data")),
        HostErrorCode::AuthorityDenied,
        "workspace path traversal is not allowed",
    );
    denied(
        sandbox.read_file(&root, &other.path().join("data")),
        HostErrorCode::AuthorityDenied,
        "absolute workspace paths are not allowed",
    );
    println!("PASS path_boundary");

    fs::write(other.path().join("data"), b"unchanged").unwrap();
    std::os::unix::fs::symlink(other.path(), fixture.path().join("link")).unwrap();
    denied(
        sandbox.read_file(&root, Path::new("link/data")),
        HostErrorCode::AuthorityDenied,
        capability_error,
    );
    denied(
        sandbox.atomic_write(&root, Path::new("link/data"), b"changed"),
        HostErrorCode::AuthorityDenied,
        capability_error,
    );
    assert_eq!(fs::read(other.path().join("data")).unwrap(), b"unchanged");
    println!("PASS static_symlink_boundary");

    let locked = fixture.path().join("locked");
    fs::create_dir(&locked).unwrap();
    fs::write(locked.join("data"), b"before").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).unwrap();
    let result = sandbox.atomic_write(&root, Path::new("locked/data"), b"after");
    // Restore fixture permissions before assertions, including on a failed expectation.
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
    denied(result, HostErrorCode::AuthorityDenied, capability_error);
    assert_eq!(fs::read(locked.join("data")).unwrap(), b"before");
    assert_eq!(fs::read_dir(&locked).unwrap().count(), 1);
    println!("PASS atomic_failure_preserves_target_and_no_temp");

    let deny = FilesystemSandbox::new(FilesystemPolicy::deny_all());
    denied(
        deny.read_file(&root, Path::new("input")),
        HostErrorCode::AuthorityDenied,
        "filesystem read is not allowed",
    );
    println!("PASS authority_denial");
    println!("ETAS-011 File Host candidate matrix passed: 8 cases");
}
