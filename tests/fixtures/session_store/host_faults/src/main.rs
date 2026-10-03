//! Test-only interpreter embedding. Product storage policy remains in Etas.
//! A fault discards a response ONLY AFTER a real SQLite committed receipt.
//! CLI: SOURCE_ROOT ENTRY_MODULE ENTRY_FLOW DB_DIRECTORY FAULT [ENTRY_ARGS...]
//! Faults are acknowledgement loss or a real test-only competing Memory writer.
//! Each invocation is one process; product calls and fixture writes are counted separately.

use std::{
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use etas_core::{DiagnosticCode, EffectDiagnosticCode, SourceId};
use etas_frontend::{
    CheckedProject, Frontend, ModulePath, ProjectCompileOptions, ProjectEntry,
    ProjectEnvironmentInput, ProjectInput, SourceInput, SourceKind,
};
use etas_host::{
    console::{ConsoleOperation, ConsoleRequest, ConsoleResponse, ConsoleResult},
    execution::OperationContext,
    memory::{MemoryMutation, MemoryNotCommitted, MemoryWriteOperation, MemoryWriteRequest, MemoryWriteResponse, MemoryWriteResult},
    session::{SessionWriteOperation, SessionWriteRequest, SessionWriteResponse, SessionWriteResult},
    *,
};
use etas_interpreter::{
    Interpreter,
    api::{EntryPoint, RunOptions, codec::value_json, entry_args_from_strings},
    host::{HostFuture, HostServiceAvailability, HostServices},
};
use serde_json::{Value, json};

struct SqliteFaultHost {
    memory: SqliteMemoryClient,
    session: SqliteSessionClient,
    fault: String,
    fault_fired: AtomicBool,
    memory_mutations: AtomicUsize,
    session_appends: AtomicUsize,
    session_resolves: AtomicUsize,
    writes_after_fault: AtomicUsize,
    denied_writes: AtomicUsize,
    reads: AtomicUsize,
    memory_reads: AtomicUsize,
    fixture_mutations: AtomicUsize,
    post_fault_reads: AtomicUsize,
    post_fault_console: AtomicUsize,
    denied_services: AtomicUsize,
    trace: Mutex<Vec<Value>>,
    stdout: Mutex<String>,
    stderr: Mutex<String>,
}

impl SqliteFaultHost {
    fn new(directory: &Path, fault: String) -> Result<Self, Box<dyn std::error::Error>> {
        if fault == "read-only"
            && (!directory.join("memory.sqlite3").is_file()
                || !directory.join("session.sqlite3").is_file())
        {
            return Err("read-only reload requires the existing synthetic stores".into());
        }
        Ok(Self {
            memory: SqliteMemoryClient::open(directory.join("memory.sqlite3"))?,
            session: SqliteSessionClient::open(directory.join("session.sqlite3"))?,
            fault,
            fault_fired: AtomicBool::new(false),
            memory_mutations: AtomicUsize::new(0),
            session_appends: AtomicUsize::new(0),
            session_resolves: AtomicUsize::new(0),
            writes_after_fault: AtomicUsize::new(0),
            denied_writes: AtomicUsize::new(0),
            reads: AtomicUsize::new(0),
            memory_reads: AtomicUsize::new(0),
            fixture_mutations: AtomicUsize::new(0),
            post_fault_reads: AtomicUsize::new(0),
            post_fault_console: AtomicUsize::new(0),
            denied_services: AtomicUsize::new(0),
            trace: Mutex::new(Vec::new()),
            stdout: Mutex::new(String::new()),
            stderr: Mutex::new(String::new()),
        })
    }

    fn before_write(&self, kind: &str) -> Result<(), HostError> {
        let after_fault = self.fault_fired.load(Ordering::SeqCst);
        if after_fault {
            self.writes_after_fault.fetch_add(1, Ordering::SeqCst);
        }
        if after_fault || self.fault == "read-only" {
            self.denied_writes.fetch_add(1, Ordering::SeqCst);
            self.trace.lock().unwrap().push(json!({"kind":kind,"denied":true}));
            return Err(HostError::new(HostErrorCode::AuthorityDenied, "test write guard"));
        }
        Ok(())
    }

    fn drop_ack(&self, kind: &str, ordinal: usize) -> HostError {
        assert!(!self.fault_fired.swap(true, Ordering::SeqCst));
        self.trace.lock().unwrap().push(json!({
            "kind":kind, "ordinal":ordinal,
            "actual_sqlite_commit":true, "acknowledgement_dropped":true
        }));
        HostError::new(HostErrorCode::ProviderUnavailable, "test lost acknowledgement after SQLite commit")
    }

    fn denied(&self, service: &str) -> HostError {
        self.denied_services.fetch_add(1, Ordering::SeqCst);
        HostError::new(HostErrorCode::AuthorityDenied, format!("test denies {service}"))
    }

    async fn competing_write(&self, read: MemoryRequest, change_save_id: bool) -> Result<(), HostError> {
        // This is a separate synthetic writer, not a returned/mock outcome or a product retry.
        let key = match &read.operation {
            MemoryOperation::Get { key } => key.clone(),
            _ => unreachable!(),
        };
        let observed = self.memory.execute(read.clone()).await?.result?;
        let MemoryResult::Value { mut value, version } = observed else {
            return Err(HostError::new(HostErrorCode::InvalidResponse, "competing writer found no row"));
        };
        if change_save_id {
            let HostValue::Record(fields) = &mut value else {
                return Err(HostError::new(HostErrorCode::InvalidResponse, "expected test metadata record"));
            };
            let (_, marker) = fields.iter_mut().find(|(name, _)| name == "save_id")
                .ok_or_else(|| HostError::new(HostErrorCode::InvalidResponse, "missing test save marker"))?;
            *marker = HostValue::String("competing-save-marker".into());
        }
        let changed = self.memory.execute(MemoryRequest {
            operation: MemoryOperation::Put { key, value, condition: WriteCondition::Match(version.clone()) },
            ..read
        }).await?.result?;
        let MemoryResult::Written { version: after } = changed else {
            return Err(HostError::new(HostErrorCode::InvalidResponse, "competing writer did not commit"));
        };
        assert_ne!(version, after);
        self.fixture_mutations.fetch_add(1, Ordering::SeqCst);
        assert!(!self.fault_fired.swap(true, Ordering::SeqCst));
        self.trace.lock().unwrap().push(json!({
            "kind":"fixture_competing_writer", "actual_sqlite_commit":true,
            "before_version":version.as_token(), "after_version":after.as_token(),
            "changed_save_id":change_save_id
        }));
        Ok(())
    }
}

macro_rules! deny_service {
    ($name:ident, $request:ty, $response:ty) => {
        fn $name<'a>(&'a self, _: OperationContext, _: $request)
            -> HostFuture<'a, Result<$response, HostError>> {
            Box::pin(async move { Err(self.denied(stringify!($name))) })
        }
    };
}

impl HostServices for SqliteFaultHost {
    fn availability(&self) -> HostServiceAvailability {
        HostServiceAvailability {
            memory: true, session: true, console: true,
            ..HostServiceAvailability::default()
        }
    }

    fn memory<'a>(&'a self, operation: OperationContext, request: MemoryRequest)
        -> HostFuture<'a, Result<MemoryResponse, HostError>> {
        Box::pin(async move {
            if !matches!(request.operation, MemoryOperation::Get { .. }) {
                return Err(self.denied("non-get legacy Memory request"));
            }
            if self.fault_fired.load(Ordering::SeqCst) {
                self.post_fault_reads.fetch_add(1, Ordering::SeqCst);
            }
            self.reads.fetch_add(1, Ordering::SeqCst);
            let ordinal = self.memory_reads.fetch_add(1, Ordering::SeqCst) + 1;
            if (self.fault == "stale-pending" && ordinal == 2)
                || (self.fault == "publish-readback" && ordinal == 3)
                || (self.fault == "reload-changed" && ordinal == 2) {
                self.competing_write(request.clone(), self.fault == "publish-readback").await?;
            }
            self.memory.execute_scoped(request, &operation).await
        })
    }

    fn memory_write<'a>(&'a self, operation: OperationContext, request: MemoryWriteRequest)
        -> HostFuture<'a, Result<MemoryWriteResponse, HostError>> {
        Box::pin(async move {
            if !matches!(request.operation, MemoryWriteOperation::Mutate { .. }) {
                return Err(self.denied("unexpected Memory receipt reconciliation"));
            }
            let ordinal = self.memory_mutations.fetch_add(1, Ordering::SeqCst) + 1;
            self.before_write("memory")?;
            if self.fault == "conflict" && ordinal == 2 {
                let MemoryWriteOperation::Mutate { mutation: MemoryMutation::Put { key, .. }, .. } = &request.operation else {
                    return Err(self.denied("conflict fault requires a metadata put"));
                };
                self.competing_write(MemoryRequest {
                    id: request.id, store: request.store.clone(), operation: MemoryOperation::Get { key: key.clone() },
                    authority: request.authority.clone(), trace: request.trace.clone(), budget: request.budget.clone()
                }, false).await?;
            }
            let response = self.memory.write_scoped(request, &operation).await?;
            let committed = matches!(&response.result,
                Ok(MemoryWriteResult::Outcome(WriteOutcome::Committed(_))));
            let conflict = matches!(&response.result,
                Ok(MemoryWriteResult::Outcome(WriteOutcome::NotCommitted {
                    reason: MemoryNotCommitted::Conflict { .. }, ..
                })));
            self.trace.lock().unwrap().push(json!({
                "kind":"memory", "ordinal":ordinal, "actual_sqlite_commit":committed,
                "actual_sqlite_cas_conflict":conflict
            }));
            if self.fault == "conflict" && ordinal == 2 && !conflict {
                return Err(HostError::new(HostErrorCode::InvalidResponse, "stale publication did not conflict"));
            }
            if (self.fault == "pending" && ordinal == 1)
                || (self.fault == "publish" && ordinal == 2) {
                if !committed {
                    return Err(HostError::new(HostErrorCode::InvalidResponse,
                        "fault target did not commit; no lost acknowledgement was injected"));
                }
                return Err(self.drop_ack("memory", ordinal));
            }
            Ok(response)
        })
    }

    fn session<'a>(&'a self, operation: OperationContext, request: SessionRequest)
        -> HostFuture<'a, Result<SessionResponse, HostError>> {
        Box::pin(async move {
            if !matches!(request.operation, SessionOperation::Load { .. }) {
                return Err(self.denied("non-load legacy Session request"));
            }
            if self.fault_fired.load(Ordering::SeqCst) {
                self.post_fault_reads.fetch_add(1, Ordering::SeqCst);
            }
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.session.execute_scoped(request, &operation).await
        })
    }

    fn session_write<'a>(&'a self, operation: OperationContext, request: SessionWriteRequest)
        -> HostFuture<'a, Result<SessionWriteResponse, HostError>> {
        Box::pin(async move {
            let append = match &request.operation {
                SessionWriteOperation::Append { .. } => {
                    self.session_appends.fetch_add(1, Ordering::SeqCst); true
                }
                SessionWriteOperation::Resolve { .. } => {
                    self.session_resolves.fetch_add(1, Ordering::SeqCst); false
                }
                _ => return Err(self.denied("unexpected Session write operation")),
            };
            let kind = if append { "append" } else { "resolve" };
            self.before_write(kind)?;
            let response = self.session.write_scoped(request, &operation).await?;
            let committed = matches!(&response.result,
                Ok(SessionWriteResult::Outcome(WriteOutcome::Committed(_))));
            self.trace.lock().unwrap().push(json!({
                "kind":kind, "actual_sqlite_commit":committed
            }));
            if append && self.fault == "append" {
                if !committed {
                    return Err(HostError::new(HostErrorCode::InvalidResponse,
                        "append did not commit; no lost acknowledgement was injected"));
                }
                return Err(self.drop_ack("append", 1));
            }
            Ok(response)
        })
    }

    fn console<'a>(&'a self, _: OperationContext, request: ConsoleRequest)
        -> HostFuture<'a, Result<ConsoleResponse, HostError>> {
        Box::pin(async move {
            if self.fault_fired.load(Ordering::SeqCst) {
                self.post_fault_console.fetch_add(1, Ordering::SeqCst);
            }
            let (destination, text, newline) = match request.operation {
                ConsoleOperation::WriteStdout { text, newline } => (&self.stdout, text, newline),
                ConsoleOperation::WriteStderr { text, newline } => (&self.stderr, text, newline),
                _ => return Err(self.denied("console input")),
            };
            let mut output = destination.lock().unwrap();
            output.push_str(&text);
            if newline { output.push('\n'); }
            Ok(ConsoleResponse { id: request.id, result: ConsoleResult::Written })
        })
    }

    deny_service!(model, ModelRequest, ModelResponse);
    deny_service!(tool, ToolRequest, ToolResponse);
    deny_service!(filesystem, FilesystemRequest, FilesystemResponse);
    deny_service!(command, CommandRequest, CommandResponse);
    deny_service!(tcp, TcpConnectRequest, TcpConnectResponse);
    deny_service!(stream, StreamRequest, StreamResponse);
    deny_service!(tls, TlsConnectRequest, TlsConnectResponse);
    deny_service!(secret, SecretRequest, SecretResponse);
    deny_service!(browser, BrowserProtocolRequest, BrowserProtocolResponse);
    deny_service!(approval, ApprovalRequest, ApprovalResponse);
    deny_service!(policy, PolicyEvaluationRequest, PolicyResponse);
}

fn source_paths(directory: &Path, output: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() { source_paths(&entry.path(), output)?; }
        else if entry.path().extension().is_some_and(|extension| extension == "es") {
            output.push(entry.path());
        }
    }
    Ok(())
}

fn checked(root: &Path, module: &str, flow: &str) -> Result<CheckedProject, Box<dyn std::error::Error>> {
    let mut paths = Vec::new();
    source_paths(root, &mut paths)?;
    paths.sort();
    let mut sources = Vec::new();
    for (index, path) in paths.into_iter().enumerate() {
        sources.push(SourceInput {
            id: SourceId(u32::try_from(index)?), text: std::fs::read_to_string(&path)?,
            path: Some(path), kind: SourceKind::SourceProjectFile,
        });
    }
    let output = Frontend.check_project(ProjectInput {
        project_root: root.to_path_buf(), source_root: Some(root.to_path_buf()),
        options: ProjectCompileOptions::default(), environment: ProjectEnvironmentInput::default(),
        sources, entry: ProjectEntry {
            module: Some(ModulePath { segments: module.split('.').map(str::to_owned).collect() }),
            flow: flow.to_owned(),
        },
    });
    let errors: Vec<_> = output.diagnostics.iter().filter(|diagnostic| {
        diagnostic.code != DiagnosticCode::Effect(EffectDiagnosticCode::RuntimeRequiredInPhase1)
    }).collect();
    if !errors.is_empty() { return Err(format!("source check failed: {errors:?}").into()); }
    output.checked.ok_or_else(|| "source check produced no checked project".into())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 5 || !["none", "pending", "append", "publish", "read-only", "conflict",
        "stale-pending", "publish-readback", "reload-changed"].contains(&args[4].as_str()) {
        return Err("usage: SOURCE_ROOT ENTRY_MODULE ENTRY_FLOW DB_DIRECTORY FAULT [ENTRY_ARGS...]".into());
    }
    let project = checked(&std::fs::canonicalize(&args[0])?, &args[1], &args[2])?;
    let host = SqliteFaultHost::new(Path::new(&args[3]), args[4].clone())?;
    let result = Interpreter.run_checked(&project,
        EntryPoint { item: project.entry.ok_or("no source entry")? },
        entry_args_from_strings(&project, args[5..].to_vec()), &host, RunOptions::default()).await?;
    println!("{}", json!({
        "fault":host.fault, "fault_fired":host.fault_fired.load(Ordering::SeqCst),
        "memory_mutations":host.memory_mutations.load(Ordering::SeqCst),
        "session_appends":host.session_appends.load(Ordering::SeqCst),
        "session_resolves":host.session_resolves.load(Ordering::SeqCst),
        "writes_after_fault":host.writes_after_fault.load(Ordering::SeqCst),
        "denied_writes":host.denied_writes.load(Ordering::SeqCst),
        "reads":host.reads.load(Ordering::SeqCst),
        "memory_reads":host.memory_reads.load(Ordering::SeqCst),
        "fixture_mutations":host.fixture_mutations.load(Ordering::SeqCst),
        "post_fault_reads":host.post_fault_reads.load(Ordering::SeqCst),
        "post_fault_console":host.post_fault_console.load(Ordering::SeqCst),
        "denied_services":host.denied_services.load(Ordering::SeqCst),
        "trace":*host.trace.lock().unwrap(), "stdout":*host.stdout.lock().unwrap(),
        "stderr":*host.stderr.lock().unwrap(), "value":result.value().map(value_json),
        "outcome":format!("{:?}",result.outcome),
        "diagnostics":result.diagnostics.iter().map(|d| d.message.clone()).collect::<Vec<_>>(),
        "events":result.events.iter().map(etas_interpreter::api::codec::event_json).collect::<Vec<_>>()
    }));
    Ok(())
}
