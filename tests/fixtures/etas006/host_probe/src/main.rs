use etas_host::{
    ActionArgPattern, ActionInstance, ApprovalGrant, ApprovalRequest, AuthorityContext,
    CommandRequest, DenyUnknownPolicyClient, ExecutionBudget, HostActionGrant, HostErrorCode,
    HostRequestId, HostTraceDigestKey, HostTraceFieldSensitivity, HostTraceMetadata,
    HostTracePayload, HostTraceRequest, HostValue, LocalPolicyDecision, LocalPolicyRule,
    LocalStaticPolicyClient, PolicyClient, PolicyDecision, PolicyContext, PolicyEvaluationRequest,
    PolicySubject, SandboxPolicy, TraceContext, TraceId,
};

const ARGV_SECRET: &str = "ETAS006_ARGV_SECRET";
const ENV_SECRET: &str = "ETAS006_ENV_SECRET";
const STDIN_SECRET: &str = "ETAS006_STDIN_SECRET";
const APPROVAL_SECRET: &str = "ETAS006_APPROVAL_SECRET";
const POLICY_SECRET: &str = "ETAS006_POLICY_SECRET";

fn pass(name: &str, detail: &str) {
    println!("CASE {name}\nRESULT pass\nDETAIL {detail}\n");
}

fn empty_authority() -> AuthorityContext {
    AuthorityContext {
        grants: Vec::new(),
        approvals: Vec::new(),
        sandbox: SandboxPolicy::deny_all(),
        policy: PolicyContext::default(),
    }
}

fn policy_request(id: u32, kind: &str, action: &str) -> PolicyEvaluationRequest {
    PolicyEvaluationRequest {
        id: HostRequestId(id),
        policy_ref: HostValue::String("etas006-policy".to_owned()),
        subject: PolicySubject {
            kind: kind.to_owned(),
            attributes: vec![
                (
                    "qualified_action".to_owned(),
                    HostValue::String(action.to_owned()),
                ),
                (
                    "resource".to_owned(),
                    HostValue::String("workspace.allowed/item".to_owned()),
                ),
            ],
        },
        authority: empty_authority(),
        trace: TraceContext::root(TraceId(u128::from(id))),
    }
}

fn assert_redacted(metadata: &HostTraceMetadata, sentinels: &[&str]) {
    let rendered = format!("{metadata:?}");
    for sentinel in sentinels {
        assert!(
            !rendered.contains(sentinel),
            "trace metadata disclosed sentinel {sentinel}: {rendered}"
        );
        assert!(
            !metadata.payload_digest.contains(sentinel),
            "trace digest disclosed sentinel {sentinel}"
        );
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let action = ActionInstance::new(
        "Fs",
        "read",
        vec![HostValue::String("workspace.allowed/item".to_owned())],
    );
    let exact = HostActionGrant::allow_with_args(
        "Fs",
        "read",
        vec![ActionArgPattern::Exact(HostValue::String(
            "workspace.allowed/item".to_owned(),
        ))],
    );
    let prefix = HostActionGrant::allow_with_args(
        "Fs",
        "read",
        vec![ActionArgPattern::Prefix(vec![
            "workspace".to_owned(),
            "allowed".to_owned(),
        ])],
    );
    let wrong_action = HostActionGrant::allow("Fs", "write");
    let wrong_resource = HostActionGrant::allow_with_args(
        "Fs",
        "read",
        vec![ActionArgPattern::Prefix(vec!["outside".to_owned()])],
    );
    assert!(exact.allows(&action));
    assert!(prefix.allows(&action));
    assert!(!wrong_action.allows(&action));
    assert!(!wrong_resource.allows(&action));
    pass(
        "authority_action_scope",
        "exact and prefix grants matched; wrong action/resource grants denied",
    );

    let stale = ApprovalGrant {
        id: HostRequestId(41),
        grants: vec![exact.clone()],
    };
    let approvals_only = AuthorityContext {
        approvals: vec![stale],
        ..empty_authority()
    };
    assert!(
        !approvals_only.allows(&action),
        "an approval record alone must not become current runtime authority"
    );
    let active = AuthorityContext {
        grants: vec![exact],
        ..empty_authority()
    };
    assert!(active.allows(&action));
    pass(
        "approval_record_not_authority",
        "stale approval record alone denied; current grant allowed",
    );

    let deny_unknown = DenyUnknownPolicyClient
        .evaluate(policy_request(1, "console", "Console.stdout_write"))
        .await
        .expect("deny-unknown response");
    assert!(matches!(
        deny_unknown.decision,
        PolicyDecision::Deny { .. }
    ));
    pass(
        "policy_unknown_fail_closed",
        "unknown policy reference returned an explicit deny decision",
    );

    let local = LocalStaticPolicyClient::deny_by_default(vec![
        LocalPolicyRule::new("console", LocalPolicyDecision::Allow)
            .qualified_action("Console.stdout_write"),
        LocalPolicyRule::new("command", LocalPolicyDecision::RequireApproval)
            .qualified_action("Command.run")
            .resource_prefix("workspace.allowed"),
    ]);
    let allowed = local
        .evaluate(policy_request(2, "console", "Console.stdout_write"))
        .await
        .expect("allow response");
    assert!(matches!(allowed.decision, PolicyDecision::Allow));
    let denied = local
        .evaluate(policy_request(3, "model", "Agentic.infer"))
        .await
        .expect("deny response");
    assert!(matches!(denied.decision, PolicyDecision::Deny { .. }));
    pass(
        "local_policy_allow_and_default_deny",
        "matching console rule allowed; unmatched model subject denied",
    );

    let approval = local
        .evaluate(policy_request(4, "command", "Command.run"))
        .await
        .expect("approval response");
    let PolicyDecision::RequireApproval { request } = approval.decision else {
        panic!("matching command rule must require approval");
    };
    assert_eq!(request.id, HostRequestId(10_000_004));
    assert_eq!(request.trace, TraceContext::root(TraceId(4)));
    assert_eq!(request.requested_grants.len(), 1);
    assert!(request.requested_grants[0].allows(&ActionInstance::new(
        "Command",
        "run",
        Vec::new(),
    )));
    pass(
        "policy_precise_approval_request",
        "request ID/trace preserved and requested grant limited to Command.run",
    );

    let key = HostTraceDigestKey::from_bytes([6; 32]);
    let command = CommandRequest {
        id: HostRequestId(5),
        argv: vec!["/bin/echo".to_owned(), ARGV_SECRET.to_owned()],
        env: vec![("TOKEN".to_owned(), ENV_SECRET.to_owned())],
        cwd: None,
        stdin: Some(STDIN_SECRET.as_bytes().to_vec()),
        authority: empty_authority(),
        trace: TraceContext::root(TraceId(5)),
        budget: ExecutionBudget::default(),
    };
    let command_metadata =
        HostTraceMetadata::from_payload(&command.trace_payload(), &key).expect("command trace");
    assert_eq!(command_metadata.qualified_action, "Command.run");
    assert_eq!(command_metadata.fields.len(), 4);
    assert!(command_metadata.fields.iter().all(|field| field.value.is_none()));
    assert_eq!(
        command_metadata
            .fields
            .iter()
            .find(|field| field.name == "env")
            .expect("env field")
            .sensitivity,
        HostTraceFieldSensitivity::Secret
    );
    assert_eq!(
        command_metadata
            .fields
            .iter()
            .find(|field| field.name == "stdin")
            .expect("stdin field")
            .sensitivity,
        HostTraceFieldSensitivity::Secret
    );
    assert_redacted(
        &command_metadata,
        &[ARGV_SECRET, ENV_SECRET, STDIN_SECRET],
    );
    let mut different_command = command.clone();
    different_command.env[0].1 = "ETAS006_DIFFERENT_SECRET".to_owned();
    let different_metadata =
        HostTraceMetadata::from_payload(&different_command.trace_payload(), &key)
            .expect("different command trace");
    assert_ne!(command_metadata.payload_digest, different_metadata.payload_digest);
    pass(
        "command_trace_redaction",
        "argv/env/stdin values absent while keyed digest remains payload-sensitive",
    );

    let approval_request = ApprovalRequest {
        id: HostRequestId(6),
        reason: APPROVAL_SECRET.to_owned(),
        requested_grants: vec![HostActionGrant::allow("Secret", "read")],
        trace: TraceContext::root(TraceId(6)),
    };
    let approval_metadata =
        HostTraceMetadata::from_payload(&approval_request.trace_payload(), &key)
            .expect("approval trace");
    assert!(approval_metadata.fields.iter().all(|field| {
        field.sensitivity == HostTraceFieldSensitivity::Sensitive && field.value.is_none()
    }));
    assert_redacted(&approval_metadata, &[APPROVAL_SECRET]);
    pass(
        "approval_trace_redaction",
        "approval reason and requested grants omitted from trace metadata",
    );

    let policy = PolicyEvaluationRequest {
        id: HostRequestId(7),
        policy_ref: HostValue::String(POLICY_SECRET.to_owned()),
        subject: PolicySubject {
            kind: "secret".to_owned(),
            attributes: vec![(
                "key".to_owned(),
                HostValue::String("ETAS006_SUBJECT_SECRET".to_owned()),
            )],
        },
        authority: empty_authority(),
        trace: TraceContext::root(TraceId(7)),
    };
    let policy_metadata =
        HostTraceMetadata::from_payload(&policy.trace_payload(), &key).expect("policy trace");
    assert!(policy_metadata.fields.iter().all(|field| {
        field.sensitivity == HostTraceFieldSensitivity::Sensitive && field.value.is_none()
    }));
    assert_redacted(
        &policy_metadata,
        &[POLICY_SECRET, "ETAS006_SUBJECT_SECRET"],
    );
    pass(
        "policy_trace_redaction",
        "policy reference and subject attributes omitted from trace metadata",
    );

    let public = HostTraceMetadata::from_payload(
        &HostTracePayload::new("fixture", "Fixture.public").with_field(
            "status",
            HostValue::String("ok".to_owned()),
            HostTraceFieldSensitivity::Public,
        ),
        &key,
    )
    .expect("public trace");
    assert_eq!(public.fields[0].value, Some(HostValue::String("ok".to_owned())));
    let duplicate = HostTraceMetadata::from_payload(
        &HostTracePayload::new("fixture", "Fixture.invalid")
            .with_field(
                "field",
                HostValue::Unit,
                HostTraceFieldSensitivity::Public,
            )
            .with_field(
                "field",
                HostValue::Unit,
                HostTraceFieldSensitivity::Secret,
            ),
        &key,
    )
    .expect_err("duplicate trace fields must fail closed");
    assert_eq!(duplicate.code, HostErrorCode::InvalidRequest);
    pass(
        "trace_public_and_invalid_fields",
        "public value retained; duplicate field names rejected as InvalidRequest",
    );

    println!("ETAS-006 host authority/policy/trace matrix passed: 9 cases");
}
