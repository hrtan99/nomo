use std::{
    fs,
    path::{Path, PathBuf},
    process::{self, Command as StdCommand},
    time::Duration,
};

use etas_host::{
    AuthorityContext, CommandClient, CommandPolicy, CommandRequest, DestructiveOpPolicy,
    ExecutionBudget, FilesystemPolicy, HostActionGrant, HostRequestId, LocalCommandClient,
    NetworkPolicy, PolicyContext, SandboxPolicy, TraceContext, TraceId,
};

const SHELL: &str = "/bin/sh";

fn cancellation_request(pid_file: &Path) -> CommandRequest {
    CommandRequest {
        id: HostRequestId(1),
        argv: vec![
            SHELL.to_owned(),
            "-c".to_owned(),
            "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30".to_owned(),
            "etas-cancellation-repro".to_owned(),
            pid_file.to_str().expect("UTF-8 pid path").to_owned(),
        ],
        env: Vec::new(),
        cwd: None,
        stdin: None,
        authority: AuthorityContext {
            grants: vec![HostActionGrant::allow("Command", "run")],
            approvals: Vec::new(),
            sandbox: SandboxPolicy::allow_listed(
                FilesystemPolicy::deny_all(),
                NetworkPolicy::deny_all(),
                CommandPolicy::allow_programs(vec![SHELL.to_owned()]),
                DestructiveOpPolicy::deny_all(),
            ),
            policy: PolicyContext::default(),
        },
        trace: TraceContext::root(TraceId(1)),
        budget: ExecutionBudget::default(),
    }
}

fn process_is_live(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
        && StdCommand::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .status()
            .is_ok_and(|status| status.success())
}

async fn wait_for_pid(pid_file: &Path) -> u32 {
    for _ in 0..100 {
        if let Ok(contents) = fs::read_to_string(pid_file)
            && let Ok(pid) = contents.trim().parse::<u32>()
        {
            return pid;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("command did not write its pid");
}

async fn terminate(pid: u32) {
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
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let pid_file = PathBuf::from(format!(
        "/tmp/etas-command-cancellation-{}.pid",
        process::id()
    ));
    let request = cancellation_request(&pid_file);
    let task = tokio::spawn(async move { LocalCommandClient::new().execute(request).await });
    let child_pid = wait_for_pid(&pid_file).await;

    task.abort();
    let cancellation = task.await.expect_err("aborted task must be cancelled");
    assert!(cancellation.is_cancelled());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let survived = process_is_live(child_pid);

    terminate(child_pid).await;
    let _ = fs::remove_file(&pid_file);
    assert!(
        survived,
        "dropping the command Future unexpectedly terminated the child"
    );
    println!("CANCELLATION: caller_cancelled=true child_pid={child_pid} child_survived=true");
    println!("CLEANUP: harness_terminated_child=true");
    println!("ETAS-0006 reproduced: cancelling the request leaves its process running");
}
