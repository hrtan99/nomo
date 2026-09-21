//! Test-only adapter checks, not source authorization or a shipped controller.
#[cfg(test)]
mod tests {
    use etas_host::*;
    use std::{fs, os::unix::fs::PermissionsExt, time::{Duration, Instant}};

    fn request(operation: MemoryOperation) -> MemoryRequest {
        MemoryRequest {
            id: HostRequestId(1),
            store: StoreRef {
                region: MemoryRegionRef { stable_id: "etas013-defaults".into(), schema_fingerprint: None },
                path: vec!["Items".into()],
            },
            operation,
            authority: AuthorityContext::deny_all(),
            trace: TraceContext::root(TraceId(1)),
            budget: Default::default(),
        }
    }

    fn put(key: &str, value: String) -> MemoryRequest {
        request(MemoryOperation::Put {
            key: HostValue::String(key.into()), value: HostValue::String(value),
            condition: WriteCondition::Any,
        })
    }

    fn get(key: &str) -> MemoryRequest {
        request(MemoryOperation::Get { key: HostValue::String(key.into()) })
    }

    #[test]
    fn actual_default_value_budget_charges_representation_overhead() {
        let limits = StorageLimits::default();
        assert_eq!(limits.max_value_bytes, 1024 * 1024);
        assert_eq!(limits.max_result_bytes, 4 * 1024 * 1024);
        assert_eq!((limits.max_depth, limits.max_nodes), (48, 16384));
        let overhead = limits.value_size(&HostValue::String(String::new())).unwrap();
        let payload = limits.max_value_bytes - overhead;
        assert_eq!(limits.value_size(&HostValue::String("x".repeat(payload))).unwrap(), limits.max_value_bytes);
        assert!(limits.value_size(&HostValue::String("x".repeat(payload + 1))).is_err());
        println!("DEFAULT_LIMIT value={} result={} string_overhead={} largest_string={}",
                 limits.max_value_bytes, limits.max_result_bytes, overhead, payload);
    }

    async fn defaults<C: MemoryClient<Error = HostError>>(client: &C) {
        let good = "x".repeat(1024 * 1024 - 4096);
        assert!(matches!(client.execute(put("good", good.clone())).await.unwrap().result.unwrap(), MemoryResult::Written { .. }));
        let rejected = client.execute(put("oversize", "x".repeat(1024 * 1024 + 1))).await;
        assert!(rejected.and_then(|response| response.result).is_err());
        assert_eq!(client.execute(get("oversize")).await.unwrap().result.unwrap(), MemoryResult::None);
        assert!(matches!(client.execute(get("good")).await.unwrap().result.unwrap(),
                         MemoryResult::Value { value: HostValue::String(value), .. } if value == good));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn unmodified_default_backends_refuse_oversize_before_mutation() {
        let workspace = TestWorkspace::create("etas013-defaults").unwrap();
        defaults(&InMemoryMemoryClient::new()).await;
        defaults(&SqliteMemoryClient::open(workspace.path().join("memory.sqlite")).unwrap()).await;
    }

    #[test]
    fn corrupt_synthetic_copy_refuses_without_rewriting_original_or_copy() {
        let workspace = TestWorkspace::create("etas013-corrupt").unwrap();
        let original = workspace.path().join("original.sqlite");
        let copy = workspace.path().join("copy.sqlite");
        let bytes = vec![0x61; 4096];
        fs::write(&original, &bytes).unwrap();
        fs::copy(&original, &copy).unwrap();
        assert!(SqliteMemoryClient::open(&copy).is_err());
        assert_eq!(fs::read(&original).unwrap(), bytes);
        assert_eq!(fs::read(&copy).unwrap(), bytes);
    }

    #[test]
    fn read_only_synthetic_database_copy_refuses_without_mutation() {
        let workspace = TestWorkspace::create("etas013-readonly").unwrap();
        let original = workspace.path().join("original.sqlite");
        let connection = rusqlite::Connection::open(&original).unwrap();
        connection.execute_batch("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('synthetic');").unwrap();
        drop(connection);
        let bytes = fs::read(&original).unwrap();
        let directory = workspace.path().join("readonly");
        fs::create_dir(&directory).unwrap();
        let copy = directory.join("copy.sqlite");
        fs::copy(&original, &copy).unwrap();
        fs::set_permissions(&copy, fs::Permissions::from_mode(0o444)).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o555)).unwrap();
        let refused = SqliteMemoryClient::open(&copy).is_err();
        // Restore only our own temporary permissions before asserting or dropping the fixture.
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&copy, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(refused);
        assert_eq!(fs::read(&original).unwrap(), bytes);
        assert_eq!(fs::read(&copy).unwrap(), bytes);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn busy_database_refuses_within_bound_and_does_not_publish_write() {
        let workspace = TestWorkspace::create("etas013-busy").unwrap();
        let path = workspace.path().join("busy.sqlite");
        let client = SqliteMemoryClient::open(&path).unwrap();
        let blocker = rusqlite::Connection::open(&path).unwrap();
        blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
        let started = Instant::now();
        let result = tokio::time::timeout(Duration::from_secs(2), client.execute(put("blocked", "value".into()))).await;
        let elapsed = started.elapsed();
        blocker.execute_batch("ROLLBACK").unwrap();
        assert!(result.expect("adapter did not settle").and_then(|response| response.result).is_err());
        assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
        assert_eq!(client.execute(get("blocked")).await.unwrap().result.unwrap(), MemoryResult::None);
        println!("BUSY_REFUSAL elapsed_ms={}", elapsed.as_millis());
    }
}
