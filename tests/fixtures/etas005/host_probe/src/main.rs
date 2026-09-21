use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command as StdCommand},
    time::{Duration, Instant},
};

use etas_host::{
    AuthorityContext, Budget, CommandClient, CommandExecutionPolicy, CommandOutput, CommandPolicy,
    CommandRequest, DestructiveOpPolicy, ExecutionBudget, FilesystemPolicy, HostActionGrant,
    HostError, HostErrorCode, HostRequestId, LocalCommandClient, NetworkPolicy, PolicyContext,
    SandboxPolicy, TimeBudget, TraceContext, TraceId,
};

const SHELL: &str = "/bin/sh";
const PYTHON: &str = "/usr/bin/python3";

fn sandbox(programs: &[&str]) -> SandboxPolicy {
    SandboxPolicy::allow_listed(
        FilesystemPolicy::deny_all(),
        NetworkPolicy::deny_all(),
        CommandPolicy::allow_programs(
            programs
                .iter()
                .map(|program| (*program).to_owned())
                .collect(),
        ),
        DestructiveOpPolicy::deny_all(),
    )
}

fn request(
    id: u32,
    argv: Vec<String>,
    env: Vec<(String, String)>,
    stdin: Option<Vec<u8>>,
    grants: Vec<HostActionGrant>,
    command_sandbox: SandboxPolicy,
    budget: ExecutionBudget,
) -> CommandRequest {
    CommandRequest {
        id: HostRequestId(id),
        argv,
        env,
        cwd: None,
        stdin,
        authority: AuthorityContext {
            grants,
            approvals: Vec::new(),
            sandbox: command_sandbox,
            policy: PolicyContext::default(),
        },
        trace: TraceContext::root(TraceId(u128::from(id))),
        budget,
    }
}

fn granted() -> Vec<HostActionGrant> {
    vec![HostActionGrant::allow("Command", "run")]
}

fn argv(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

async fn execute(request: CommandRequest) -> CommandOutput {
    LocalCommandClient::new()
        .execute(request)
        .await
        .expect("command host request")
        .result
        .expect("command result")
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

fn pass(name: &str, detail: impl AsRef<str>) {
    println!("CASE {name}\nRESULT pass\nDETAIL {}\n", detail.as_ref());
}

fn process_is_live(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
        && StdCommand::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
}

async fn wait_for_pid(path: &Path) -> u32 {
    for _ in 0..100 {
        if let Ok(contents) = fs::read_to_string(path)
            && let Ok(pid) = contents.trim().parse::<u32>()
        {
            return pid;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("command did not write its pid before cancellation");
}

async fn terminate_fixture_process(pid: u32) {
    let _ = StdCommand::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    for _ in 0..100 {
        if !process_is_live(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _ = StdCommand::new("/bin/kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    for _ in 0..100 {
        if !process_is_live(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("fixture cleanup could not reap command process {pid}");
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let output = execute(request(
        1,
        argv(&[SHELL, "-c", "printf ETAS005_OK"]),
        Vec::new(),
        None,
        granted(),
        sandbox(&[SHELL]),
        ExecutionBudget::default(),
    ))
    .await;
    assert_eq!(output.exit_code, 0);
    assert_eq!(output.stdout, b"ETAS005_OK");
    assert!(output.stderr.is_empty());
    pass("command_success", "exit=0 stdout=ETAS005_OK stderr_bytes=0");

    let output = execute(request(
        2,
        argv(&[
            SHELL,
            "-c",
            "printf ETAS005_OUT; printf ETAS005_ERR >&2; exit 7",
        ]),
        Vec::new(),
        None,
        granted(),
        sandbox(&[SHELL]),
        ExecutionBudget::default(),
    ))
    .await;
    assert_eq!(output.exit_code, 7);
    assert_eq!(output.stdout, b"ETAS005_OUT");
    assert_eq!(output.stderr, b"ETAS005_ERR");
    pass(
        "nonzero_exit",
        "exit=7 returned as CommandOutput with stdout/stderr preserved",
    );

    let output = execute(request(
        3,
        argv(&[
            SHELL,
            "-c",
            "IFS= read -r line; printf '%s|%s|%s|%s' \"$1\" \"$2\" \"$ETAS005_ENV\" \"$line\"; printf '%s|%s' \"${HOME-unset}\" \"${NOMO_GATEWAY_CLIENT_TOKEN-unset}\" >&2",
            "etas005-fixture",
            "argument with spaces",
            "*?[literal]",
        ]),
        vec![("ETAS005_ENV".to_owned(), "explicit-value".to_owned())],
        Some(b"stdin-value\n".to_vec()),
        granted(),
        sandbox(&[SHELL]),
        ExecutionBudget::default(),
    ))
    .await;
    assert_eq!(output.exit_code, 0);
    assert_eq!(
        output.stdout,
        b"argument with spaces|*?[literal]|explicit-value|stdin-value"
    );
    assert_eq!(
        output.stderr, b"unset|unset",
        "inherited HOME and gateway credential sentinel must be cleared"
    );
    pass(
        "arguments_environment_stdin",
        "argv/stdin preserved; explicit env set; inherited HOME and gateway credential cleared",
    );

    let output = execute(request(
        4,
        argv(&[
            PYTHON,
            "-c",
            "import sys; sys.stdout.buffer.write(b'O' * 1048576); sys.stderr.buffer.write(b'E' * 1048576)",
        ]),
        Vec::new(),
        None,
        granted(),
        sandbox(&[PYTHON]),
        ExecutionBudget::default(),
    ))
    .await;
    assert_eq!(output.exit_code, 0);
    assert_eq!(output.stdout.len(), 1_048_576);
    assert_eq!(output.stderr.len(), 1_048_576);
    pass(
        "large_output",
        "stdout_bytes=1048576 stderr_bytes=1048576 captured exactly",
    );
    for (id, script, stream) in [
        (
            40,
            "import sys; sys.stdout.buffer.write(b'O' * 4097)",
            "stdout",
        ),
        (
            41,
            "import sys; sys.stderr.buffer.write(b'E' * 4097)",
            "stderr",
        ),
        (
            42,
            "import os,threading; t=threading.Thread(target=lambda: os.write(2,b'E'*65536)); t.start(); os.write(1,b'O'*65536); t.join()",
            "either",
        ),
    ] {
        let error = tokio::time::timeout(
            Duration::from_secs(3),
            LocalCommandClient::with_policy(CommandExecutionPolicy::new(4096, 4096)).execute(
                request(
                    id,
                    argv(&[PYTHON, "-c", script]),
                    Vec::new(),
                    None,
                    granted(),
                    sandbox(&[PYTHON]),
                    ExecutionBudget::default(),
                ),
            ),
        )
        .await
        .expect("output collection must not deadlock");
        let error = expect_error(error, HostErrorCode::BudgetExceeded, "capture limit");
        assert!(
            error
                .details
                .iter()
                .any(|d| d.key == "limit_bytes" && d.value == "4096")
        );
        assert!(
            error
                .details
                .iter()
                .any(|d| d.key == "stream" && (d.value == stream || stream == "either"))
        );
    }
    pass(
        "bounded_output",
        "per-stream cap=4096; stdout, stderr and simultaneous overflow return BudgetExceeded",
    );
    for size in [0, 4095, 4096] {
        let script = format!("import os; os.write(1,b'O'*{size}); os.write(2,b'E'*{size})");
        let output = tokio::time::timeout(
            Duration::from_secs(3),
            LocalCommandClient::with_policy(CommandExecutionPolicy::new(4096, 4096)).execute(
                request(
                    43,
                    argv(&[PYTHON, "-c", &script]),
                    Vec::new(),
                    None,
                    granted(),
                    sandbox(&[PYTHON]),
                    ExecutionBudget::default(),
                ),
            ),
        )
        .await
        .expect("boundary output must finish")
        .expect("cap permits exact limit")
        .result
        .expect("command output");
        assert_eq!(output.stdout, vec![b'O'; size]);
        assert_eq!(output.stderr, vec![b'E'; size]);
    }
    pass(
        "output_cap_edges",
        "0, limit-1 and exact per-stream limit preserved",
    );

    let denied_marker = PathBuf::from(format!("/tmp/nomo-etas005-denied-marker-{}", process::id()));
    let error = LocalCommandClient::new()
        .execute(request(
            5,
            argv(&[
                SHELL,
                "-c",
                "printf spawned > \"$1\"",
                "etas005-fixture",
                denied_marker.to_str().expect("UTF-8 marker path"),
            ]),
            Vec::new(),
            None,
            Vec::new(),
            sandbox(&[SHELL]),
            ExecutionBudget::default(),
        ))
        .await;
    expect_error(
        error,
        HostErrorCode::AuthorityDenied,
        "requires a checked Command.run grant",
    );
    assert!(!denied_marker.exists());
    pass(
        "denied_missing_grant",
        "AuthorityDenied before spawn; marker absent",
    );

    let error = LocalCommandClient::new()
        .execute(request(
            6,
            argv(&[
                SHELL,
                "-c",
                "printf spawned > \"$1\"",
                "etas005-fixture",
                denied_marker.to_str().expect("UTF-8 marker path"),
            ]),
            Vec::new(),
            None,
            granted(),
            SandboxPolicy::allow_listed(
                FilesystemPolicy::deny_all(),
                NetworkPolicy::deny_all(),
                CommandPolicy::deny_all(),
                DestructiveOpPolicy::deny_all(),
            ),
            ExecutionBudget::default(),
        ))
        .await;
    expect_error(
        error,
        HostErrorCode::AuthorityDenied,
        "command execution is not allowlisted",
    );
    assert!(!denied_marker.exists());
    pass(
        "denied_command_allowlist",
        "AuthorityDenied before spawn; marker absent",
    );

    let budget = ExecutionBudget::start(Budget {
        time: Some(TimeBudget { max_millis: 50 }),
        ..Budget::default()
    });
    let started = Instant::now();
    let timeout_client = LocalCommandClient::new();
    let output = timeout_client.execute(request(
        7,
        argv(&[PYTHON, "-c", "import time; time.sleep(5)"]),
        Vec::new(),
        None,
        granted(),
        sandbox(&[PYTHON]),
        budget,
    ));
    let output = tokio::time::timeout(Duration::from_secs(2), output)
        .await
        .expect("runtime must stop command before harness watchdog");
    let elapsed = started.elapsed();
    expect_error(output, HostErrorCode::BudgetExceeded, "time budget");
    assert!(elapsed < Duration::from_secs(2));
    pass(
        "command_timeout",
        format!(
            "configured_budget_ms=50 workload_ms=5000 elapsed_ms={}; BudgetExceeded",
            elapsed.as_millis()
        ),
    );

    let pid_file = PathBuf::from(format!("/tmp/nomo-etas005-child-{}.pid", process::id()));
    let descendant_file = pid_file.with_extension("descendant.pid");
    let script = "/bin/sleep 30 & printf '%s' \"$!\" > \"$2\"; printf '%s' \"$$\" > \"$1\"; wait";
    let cancellation_request = request(
        8,
        argv(&[
            SHELL,
            "-c",
            script,
            "etas005-fixture",
            pid_file.to_str().expect("UTF-8 pid path"),
            descendant_file.to_str().expect("UTF-8 descendant path"),
        ]),
        Vec::new(),
        None,
        granted(),
        sandbox(&[SHELL]),
        ExecutionBudget::default(),
    );
    let task = tokio::spawn(async move {
        LocalCommandClient::new()
            .execute(cancellation_request)
            .await
    });
    let child_pid = wait_for_pid(&pid_file).await;
    let descendant_pid = wait_for_pid(&descendant_file).await;
    task.abort();
    let cancellation = task
        .await
        .expect_err("aborted command task must be cancelled");
    assert!(cancellation.is_cancelled());
    for _ in 0..200 {
        if !process_is_live(child_pid) && !process_is_live(descendant_pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let runtime_cleaned = !process_is_live(child_pid) && !process_is_live(descendant_pid);
    // Cleanup cannot turn a failed runtime observation into a passing assertion.
    if !runtime_cleaned {
        terminate_fixture_process(child_pid).await;
        terminate_fixture_process(descendant_pid).await;
    }
    assert!(
        runtime_cleaned,
        "runtime left child/descendant after Future cancellation"
    );
    pass(
        "command_cancellation",
        "caller task cancelled; owned child terminated and reaped",
    );
    pass(
        "orphan_process_cleanup",
        "owned descendant gone before harness cleanup",
    );
    let _ = fs::remove_file(&pid_file);
    let _ = fs::remove_file(&descendant_file);
    pass(
        "fixture_process_cleanup",
        "no process cleanup needed on success; removed fixture pid files",
    );

    println!("ETAS-005 host command matrix completed: 12 pass");
}
