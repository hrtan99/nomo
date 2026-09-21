use std::time::{Duration, Instant};

use etas_host::{
    AuthorityContext, Budget, CommandClient, CommandOutput, CommandPolicy, CommandRequest,
    DestructiveOpPolicy, ExecutionBudget, FilesystemPolicy, HostActionGrant, HostRequestId,
    LocalCommandClient, NetworkPolicy, PolicyContext, SandboxPolicy, TimeBudget, TraceContext,
    TraceId,
};

const PYTHON: &str = "/usr/bin/python3";

fn request(id: u32, code: &str, budget: ExecutionBudget) -> CommandRequest {
    CommandRequest {
        id: HostRequestId(id),
        argv: vec![PYTHON.to_owned(), "-c".to_owned(), code.to_owned()],
        env: Vec::new(),
        cwd: None,
        stdin: None,
        authority: AuthorityContext {
            grants: vec![HostActionGrant::allow("Command", "run")],
            approvals: Vec::new(),
            sandbox: SandboxPolicy::allow_listed(
                FilesystemPolicy::deny_all(),
                NetworkPolicy::deny_all(),
                CommandPolicy::allow_programs(vec![PYTHON.to_owned()]),
                DestructiveOpPolicy::deny_all(),
            ),
            policy: PolicyContext::default(),
        },
        trace: TraceContext::root(TraceId(u128::from(id))),
        budget,
    }
}

async fn execute(request: CommandRequest) -> CommandOutput {
    LocalCommandClient::new()
        .execute(request)
        .await
        .expect("command host request")
        .result
        .expect("command result")
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let budget = ExecutionBudget::start(Budget {
        time: Some(TimeBudget { max_millis: 50 }),
        ..Budget::default()
    });
    let started = Instant::now();
    let timeout_output = execute(request(1, "import time; time.sleep(0.30)", budget)).await;
    let elapsed = started.elapsed();
    assert_eq!(timeout_output.exit_code, 0);
    assert!(
        elapsed >= Duration::from_millis(250),
        "the 50 ms budget unexpectedly stopped the command after {elapsed:?}"
    );
    println!(
        "TIME_BOUND: configured_ms=50 actual_exit=0 elapsed_ms={} deadline_ignored=true",
        elapsed.as_millis()
    );

    let output = execute(request(
        2,
        "import sys; sys.stdout.buffer.write(b'O' * 1048576); sys.stderr.buffer.write(b'E' * 1048576)",
        ExecutionBudget::default(),
    ))
    .await;
    assert_eq!(output.exit_code, 0);
    assert_eq!(output.stdout.len(), 1_048_576);
    assert_eq!(output.stderr.len(), 1_048_576);
    println!(
        "OUTPUT_BOUND: stdout_bytes={} stderr_bytes={} fully_buffered=true",
        output.stdout.len(),
        output.stderr.len()
    );
    println!("ETAS-0005 reproduced: command time and output bounds are not enforced");
}
