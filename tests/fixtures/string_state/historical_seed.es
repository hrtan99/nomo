module app.main;

import std.io.println;
import nomo.domain.wire.encode;

import nomo.native.configuration.Data as Old0;
import nomo.native.configuration.Cached as Old1;
import nomo.native.mutations.Data as Old2;
import nomo.native.mutations.Journal as Old3;
import nomo.native.mutations.Step as Old4;
import nomo.native.mutations.SavedPath as Old5;
import nomo.native.processes.Data as Old6;
import nomo.native.processes.Job as Old7;
import nomo.native.processes.JobEvent as Old8;
import nomo.native.projects.Data as Old9;
import nomo.session.chat_history.Legacy as Old10;
import nomo.session.chat_session_contract.Session as Old11;
import nomo.harness.harness_tool_chat_contract.Invocation as Old12;
import nomo.harness.harness_tool_contract.Ledger as Old13;
import nomo.harness.harness_tool_chat_contract.Previous as Old14;
import nomo.session.chat_history.Frames as Old15;
import nomo.session.chat_history.Frame as Old16;
import nomo.core.conversation.Event as Old17;
import nomo.session.check_output.Outputs as Old18;
import nomo.session.check_output.Record as Old19;
import nomo.session.demo_claim.Demo as Old20;
import nomo.session.demo_claim.Claim as Old21;
import nomo.session.continuous_work.Books as Old22;
import nomo.session.continuous_work.Book as Old23;
import nomo.session.continuous_work.Entry as Old24;
import nomo.session.continuous_work.Core as Old25;
import nomo.session.continuous_work.Edit as Old26;
import nomo.session.edit_operation.Binding as Old27;
import nomo.session.continuous_work.ResultData as Old28;
import nomo.session.continuous_work.Check as Old29;
import nomo.session.edit_operation_store.Operations as Old30;
import nomo.session.edit_operation.Record as Old31;
import nomo.session.edit_operation_store.Followups as Old32;
import nomo.session.event_history.EventStore as Old33;
import nomo.session.event_history.History as Old34;
import nomo.session.harness_checkpoint_store.Checkpoints as Old35;
import nomo.session.harness_checkpoint_store.Record as Old36;
import nomo.session.harness_checkpoint.Identity as Old37;
import nomo.session.harness_successor_store.Successors as Old38;
import nomo.session.harness_successor_store.Record as Old39;
import nomo.session.history_first_check_rows.Checks as Old40;
import nomo.session.history_check_store.Record as Old41;
import nomo.session.history_followup_check_guard.Checks as Old42;
import nomo.session.history_work_guard.Runs as Old43;
import nomo.session.history_work_guard.Record as Old44;
import nomo.session.history_work_guard.Budget as Old45;
import nomo.harness.harness_work_contract.Ledger as Old46;
import nomo.harness.harness_edit_contract.Ledger as Old47;
import nomo.session.history_followup_guard.Runs as Old48;
import nomo.session.history_followup_guard.Record as Old49;
import nomo.session.history_followup_guard.Parent as Old50;
import nomo.session.history_followup_guard.Budget as Old51;
import nomo.session.recoverable_check_store.Checks as Old52;
import nomo.session.check_store.Frame as Old53;
import nomo.session.recoverable_chat_store.Frames as Old54;
import nomo.session.recoverable_chat_store.Frame as Old55;
import nomo.session.recoverable_events.Frame as Old56;
import nomo.session.recoverable_chat_store.EvidenceFrames as Old57;
import nomo.session.recoverable_chat_store.Evidence as Old58;
import nomo.session.recoverable_followup_check_store.Checks as Old59;
import nomo.session.recoverable_followup_store.Runs as Old60;
import nomo.session.recoverable_followup_store.Frame as Old61;
import nomo.session.recoverable_work_store.Runs as Old62;
import nomo.session.recoverable_work_store.Frame as Old63;
import nomo.session.recovery_decision.Decisions as Old64;
import nomo.session.recovery_decision.Decision as Old65;
import nomo.session.metadata_store.Metadata as Old66;
import nomo.session.store_record.Record as Old67;
import nomo.session.session_state.Snapshot as Old68;
import nomo.core.conversation.State as Old69;
import nomo.session.session_state.Reference as Old70;
import nomo.session.session_state.Operation as Old71;
import nomo.session.session_state.Caps as Old72;
import nomo.session.session_state.Ledger as Old73;
import nomo.session.work_chain_journal.Journal as Old74;
import nomo.session.work_chain_journal.Record as Old75;
import nomo.session.work_chain_store.Chain as Old76;
import nomo.session.work_chain.Record as Old77;
import nomo.session.work_chain.Caps as Old78;
import nomo.session.work_record.Record as Old79;
import nomo.session.work_record_store.Work as Old80;
import app.old_conversations.Data as Old81;
import nomo.native.history.Session as Old82;
import nomo.native.history.Ledger as Old83;
import nomo.native.history.Event as Old84;
import app.old_conversations.Copies as Old85;
import nomo.native.history.CopyJob as Old86;
import app.old_jobs.ArchivedJobs as Old87;
import nomo.domain.process.archived_jobs.ArchivedJob as Old88;
import app.old_journals.Data as Old89;
import nomo.native.lifecycle.Attempt as Old90;
import nomo.session.user_context_chain_v4_journal.Journal as Old91;
import nomo.session.user_context_chain_v4_journal.Record as Old92;
import nomo.session.user_context_chain_v4.RootIdentity as Old93;
import nomo.session.user_context_chain_v4_store.Chain as Old94;
import nomo.session.user_context_chain_v4.Record as Old95;
import std.codec.text.utf8_encode;

type WireReadContext = {
    phase: string,
    request: string,
    task: string,
    result: string,
    tool: string,
    outcome: string,
    allowed: Array<string>
};
flow protocol<T>(label: string, value: T) -> unit ![Console, Error<std.io.IOError>] {
    println(
        "[PROTOCOL] " + label + "=" + match encode(value, "projection failed", "encoding failed") {
            Ok(value) => value,
            Err(error) => abort(error)
        }
    );
}

public flow main(args: Array<string>) -> i32 ![
    Memory,
    Console,
    Error<StorageError>,
    Error<MemoryConflict>,
    Error<IndexError>,
    Error<std.io.IOError>
] {
    Old0.Parsed.insert(
        "row-0",
        Old1 {
            digest = utf8_encode("鹈鹕\0\n"),
            session = "鹈鹕\\nreserved: session",
            result_event = 9007199254740993
        }
    );
    Old2.Journals.insert(
        "row-1",
        Old3 {
            id = "鹈鹕\\nreserved: id",
            session = "鹈鹕\\nreserved: session",
            name = "鹈鹕\\nreserved: name",
            call = 9007199254740993,
            phase = "applying",
            steps = 9007199254740993,
            message = "鹈鹕\\nreserved: message",
            owner_call = 9007199254740993,
            owner_name = "鹈鹕\\nreserved: owner_name"
        }
    );
    Old2.Steps.insert(
        "row-2",
        Old4 {
            phase = "applying",
            paths = [
                Old5 {
                    path = "鹈鹕\\nreserved: path",
                    before_exists = true,
                    before = "鹈鹕\\nreserved: before",
                    after_exists = true,
                    after = "鹈鹕\\nreserved: after"
                }
            ]
        }
    );
    Old6.Jobs.insert(
        "row-3",
        Old7 {
            id = "鹈鹕\\nreserved: id",
            session = "鹈鹕\\nreserved: session",
            program = "鹈鹕\\nreserved: program",
            arguments = ["鹈鹕\\nreserved: arguments"],
            handle = "鹈鹕\\nreserved: handle",
            phase = "started"
        }
    );
    Old6.Outputs.insert(
        "row-4",
        Old8 {
            job = "鹈鹕\\nreserved: job",
            call = 9007199254740993,
            phase = "output",
            exit_code = Some(37),
            stdout = "鹈鹕\\nreserved: stdout",
            stderr = "鹈鹕\\nreserved: stderr",
            stdout_bytes = utf8_encode("鹈鹕\0\n"),
            stderr_bytes = utf8_encode("鹈鹕\0\n")
        }
    );
    Old9.Recent.insert("row-5", ["鹈鹕\\nreserved: "]);
    Old10.Rows.insert(
        "row-6",
        Old11 {
            format = 37,
            phase = "running",
            invocation = Old12 {
                usage = Old13 {
                    steps = 37,
                    calls = 37,
                    tokens = 37,
                    tools = 37,
                    scan = 37
                },
                maximum = Old13 {
                    steps = 37,
                    calls = 37,
                    tokens = 37,
                    tools = 37,
                    scan = 37
                },
                admitted = 37,
                prior = Old14 {
                    task = "鹈鹕\\nreserved: task",
                    result = "鹈鹕\\nreserved: result",
                    tool = "search",
                    outcome = "鹈鹕\\nreserved: outcome",
                    answer = "鹈鹕\\nreserved: answer"
                }
            },
            last_request = "鹈鹕\\nreserved: last_request",
            pending = "鹈鹕\\nreserved: pending"
        }
    );
    Old15.Rows.insert(
        "row-7",
        Old16 {
            format = 37,
            chat = Old11 {
                format = 37,
                phase = "running",
                invocation = Old12 {
                    usage = Old13 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        tools = 37,
                        scan = 37
                    },
                    maximum = Old13 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        tools = 37,
                        scan = 37
                    },
                    admitted = 37,
                    prior = Old14 {
                        task = "鹈鹕\\nreserved: task",
                        result = "鹈鹕\\nreserved: result",
                        tool = "search",
                        outcome = "鹈鹕\\nreserved: outcome",
                        answer = "鹈鹕\\nreserved: answer"
                    }
                },
                last_request = "鹈鹕\\nreserved: last_request",
                pending = "鹈鹕\\nreserved: pending"
            },
            first_count = 37,
            events = [
                Old17 {
                    role = "user",
                    kind = "input",
                    name = "鹈鹕\\nreserved: name",
                    text = "鹈鹕\\nreserved: text"
                }
            ]
        }
    );
    Old18.Rows.insert(
        "row-8",
        Old19 {
            format = 37,
            slot = "first",
            id = "鹈鹕\\nreserved: id",
            digest = "鹈鹕\\nreserved: digest",
            stdout = "鹈鹕\\nreserved: stdout",
            stderr = "鹈鹕\\nreserved: stderr",
            stdout_truncated = true,
            stderr_truncated = true
        }
    );
    Old20.Claims.insert(
        "row-9",
        Old21 {
            format = 37,
            phase = "continue-claimed",
            session_id = "鹈鹕\\nreserved: session_id",
            save_id = "鹈鹕\\nreserved: save_id",
            binding = "鹈鹕\\nreserved: binding",
            maximum = 37,
            budget = 37
        }
    );
    Old22.Rows.insert(
        "row-10",
        Old23 {
            binding = "鹈鹕\\nreserved: binding",
            history = [
                Old24 {
                    core = Old25 {
                        id = "鹈鹕\\nreserved: id",
                        request = "鹈鹕\\nreserved: request"
                    },
                    edit = Old26 {
                        phase = "intent",
                        binding = Some(
                            Old27 {
                                id = "鹈鹕\\nreserved: id",
                                workspace = "鹈鹕\\nreserved: workspace",
                                region = "nomo.tools.edit_file.EditableRoot",
                                path = "鹈鹕\\nreserved: path",
                                request_digest = "鹈鹕\\nreserved: request_digest",
                                before_digest = "鹈鹕\\nreserved: before_digest",
                                after_digest = "鹈鹕\\nreserved: after_digest",
                                before_bytes = 37,
                                after_bytes = 37
                            }
                        )
                    },
                    result = Old28 {
                        phase = "complete",
                        summary = "鹈鹕\\nreserved: summary",
                        source = "model-v5",
                        calls = 37,
                        generation = 37,
                        events = [
                            Old17 {
                                role = "user",
                                kind = "input",
                                name = "鹈鹕\\nreserved: name",
                                text = "鹈鹕\\nreserved: text"
                            }
                        ]
                    },
                    check = Old29 {
                        phase = "complete",
                        digest = "鹈鹕\\nreserved: digest",
                        outcome = "failed",
                        exit_code = "37",
                        stdout = "鹈鹕\\nreserved: stdout",
                        stderr = "鹈鹕\\nreserved: stderr",
                        stdout_truncated = true,
                        stderr_truncated = true
                    }
                }
            ],
            current = Old24 {
                core = Old25 {
                    id = "鹈鹕\\nreserved: id",
                    request = "鹈鹕\\nreserved: request"
                },
                edit = Old26 {
                    phase = "intent",
                    binding = Some(
                        Old27 {
                            id = "鹈鹕\\nreserved: id",
                            workspace = "鹈鹕\\nreserved: workspace",
                            region = "nomo.tools.edit_file.EditableRoot",
                            path = "鹈鹕\\nreserved: path",
                            request_digest = "鹈鹕\\nreserved: request_digest",
                            before_digest = "鹈鹕\\nreserved: before_digest",
                            after_digest = "鹈鹕\\nreserved: after_digest",
                            before_bytes = 37,
                            after_bytes = 37
                        }
                    )
                },
                result = Old28 {
                    phase = "running",
                    summary = "鹈鹕\\nreserved: summary",
                    source = "high-input-v2",
                    calls = 37,
                    generation = 37,
                    events = [
                        Old17 {
                            role = "user",
                            kind = "input",
                            name = "鹈鹕\\nreserved: name",
                            text = "鹈鹕\\nreserved: text"
                        }
                    ]
                },
                check = Old29 {
                    phase = "running",
                    digest = "鹈鹕\\nreserved: digest",
                    outcome = "",
                    exit_code = "",
                    stdout = "鹈鹕\\nreserved: stdout",
                    stderr = "鹈鹕\\nreserved: stderr",
                    stdout_truncated = true,
                    stderr_truncated = true
                }
            }
        }
    );
    Old30.Rows.insert(
        "row-11",
        Old31 {
            format = 37,
            phase = "intent",
            binding = Old27 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                region = "nomo.tools.edit_file.EditableRoot",
                path = "鹈鹕\\nreserved: path",
                request_digest = "鹈鹕\\nreserved: request_digest",
                before_digest = "鹈鹕\\nreserved: before_digest",
                after_digest = "鹈鹕\\nreserved: after_digest",
                before_bytes = 37,
                after_bytes = 37
            }
        }
    );
    Old32.Rows.insert(
        "row-12",
        Old31 {
            format = 37,
            phase = "intent",
            binding = Old27 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                region = "nomo.tools.edit_file.EditableRoot",
                path = "鹈鹕\\nreserved: path",
                request_digest = "鹈鹕\\nreserved: request_digest",
                before_digest = "鹈鹕\\nreserved: before_digest",
                after_digest = "鹈鹕\\nreserved: after_digest",
                before_bytes = 37,
                after_bytes = 37
            }
        }
    );
    Old33.Rows.insert(
        "row-13",
        Old34 {
            format = 37,
            turns = 37,
            first_count = 37,
            events = [
                Old17 {
                    role = "user",
                    kind = "input",
                    name = "鹈鹕\\nreserved: name",
                    text = "鹈鹕\\nreserved: text"
                }
            ]
        }
    );
    Old35.Rows.insert(
        "row-14",
        Old36 {
            format = 37,
            phase = "claimed",
            identity = Old37 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                allowed = ["鹈鹕\\nreserved: allowed"]
            },
            body = "鹈鹕\\nreserved: body"
        }
    );
    Old38.Rows.insert(
        "row-15",
        Old39 {
            format = 37,
            phase = "admitted",
            predecessor = Old37 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                allowed = ["鹈鹕\\nreserved: allowed"]
            },
            successor = Old37 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                allowed = ["鹈鹕\\nreserved: allowed"]
            },
            predecessor_version = "historical-version",
            predecessor_body = "鹈鹕\\nreserved: predecessor_body",
            request = "鹈鹕\\nreserved: request",
            body = "鹈鹕\\nreserved: body",
            usage = Old13 {
                steps = 37,
                calls = 37,
                tokens = 37,
                tools = 37,
                scan = 37
            },
            maximum = Old13 {
                steps = 37,
                calls = 37,
                tokens = 37,
                tools = 37,
                scan = 37
            },
            reserved = Old13 {
                steps = 37,
                calls = 37,
                tokens = 37,
                tools = 37,
                scan = 37
            },
            admitted = 37,
            resolved = true
        }
    );
    Old40.Rows.insert(
        "row-16",
        Old41 {
            format = 37,
            phase = "running",
            id = "鹈鹕\\nreserved: id",
            digest = "鹈鹕\\nreserved: digest",
            outcome = "",
            exit_code = ""
        }
    );
    Old42.Rows.insert(
        "row-17",
        Old41 {
            format = 37,
            phase = "complete",
            id = "鹈鹕\\nreserved: id",
            digest = "鹈鹕\\nreserved: digest",
            outcome = "passed",
            exit_code = "0"
        }
    );
    Old43.Rows.insert(
        "row-18",
        Old44 {
            format = 37,
            phase = "abandoned",
            id = "鹈鹕\\nreserved: id",
            workspace = "鹈鹕\\nreserved: workspace",
            path = "鹈鹕\\nreserved: path",
            request = "鹈鹕\\nreserved: request",
            history_version = "historical-version",
            reserved = Old45 {
                steps = 37,
                calls = 37,
                generation = 37,
                native_tokens = 37
            },
            settled = Some(
                Old46 {
                    read = Old13 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        tools = 37,
                        scan = 37
                    },
                    edit = Old47 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        native_tokens = 37,
                        boundaries = 37
                    }
                }
            ),
            summary = "鹈鹕\\nreserved: summary"
        }
    );
    Old48.Rows.insert(
        "row-19",
        Old49 {
            format = 37,
            phase = "running",
            id = "鹈鹕\\nreserved: id",
            workspace = "鹈鹕\\nreserved: workspace",
            path = "鹈鹕\\nreserved: path",
            request = "鹈鹕\\nreserved: request",
            history_version = "historical-version",
            parent = Old50 {
                work = Old44 {
                    format = 37,
                    phase = "abandoned",
                    id = "鹈鹕\\nreserved: id",
                    workspace = "鹈鹕\\nreserved: workspace",
                    path = "鹈鹕\\nreserved: path",
                    request = "鹈鹕\\nreserved: request",
                    history_version = "historical-version",
                    reserved = Old45 {
                        steps = 37,
                        calls = 37,
                        generation = 37,
                        native_tokens = 37
                    },
                    settled = Some(
                        Old46 {
                            read = Old13 {
                                steps = 37,
                                calls = 37,
                                tokens = 37,
                                tools = 37,
                                scan = 37
                            },
                            edit = Old47 {
                                steps = 37,
                                calls = 37,
                                tokens = 37,
                                native_tokens = 37,
                                boundaries = 37
                            }
                        }
                    ),
                    summary = "鹈鹕\\nreserved: summary"
                },
                edit = Old31 {
                    format = 37,
                    phase = "intent",
                    binding = Old27 {
                        id = "鹈鹕\\nreserved: id",
                        workspace = "鹈鹕\\nreserved: workspace",
                        region = "nomo.tools.edit_file.EditableRoot",
                        path = "鹈鹕\\nreserved: path",
                        request_digest = "鹈鹕\\nreserved: request_digest",
                        before_digest = "鹈鹕\\nreserved: before_digest",
                        after_digest = "鹈鹕\\nreserved: after_digest",
                        before_bytes = 37,
                        after_bytes = 37
                    }
                },
                check = Some(
                    Old41 {
                        format = 37,
                        phase = "running",
                        id = "鹈鹕\\nreserved: id",
                        digest = "鹈鹕\\nreserved: digest",
                        outcome = "",
                        exit_code = ""
                    }
                )
            },
            reserved = Old51 {
                steps = 37,
                calls = 37,
                generation = 37,
                native_tokens = 37
            },
            settled = Some(
                Old46 {
                    read = Old13 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        tools = 37,
                        scan = 37
                    },
                    edit = Old47 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        native_tokens = 37,
                        boundaries = 37
                    }
                }
            ),
            summary = "鹈鹕\\nreserved: summary"
        }
    );
    Old52.Rows.insert(
        "row-20",
        Old53 {
            format = 37,
            policy_binding = "鹈鹕\\nreserved: policy_binding",
            work_history = "鹈鹕\\nreserved: work_history",
            workspace = "鹈鹕\\nreserved: workspace",
            path = "鹈鹕\\nreserved: path",
            check = Old41 {
                format = 37,
                phase = "running",
                id = "鹈鹕\\nreserved: id",
                digest = "鹈鹕\\nreserved: digest",
                outcome = "",
                exit_code = ""
            },
            stdout = "鹈鹕\\nreserved: stdout",
            stderr = "鹈鹕\\nreserved: stderr",
            stdout_truncated = true,
            stderr_truncated = true
        }
    );
    Old54.Rows.insert(
        "row-21",
        Old55 {
            format = 37,
            encoding = "鹈鹕\\nreserved: encoding",
            policy_binding = "鹈鹕\\nreserved: policy_binding",
            chat = Old11 {
                format = 37,
                phase = "running",
                invocation = Old12 {
                    usage = Old13 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        tools = 37,
                        scan = 37
                    },
                    maximum = Old13 {
                        steps = 37,
                        calls = 37,
                        tokens = 37,
                        tools = 37,
                        scan = 37
                    },
                    admitted = 37,
                    prior = Old14 {
                        task = "鹈鹕\\nreserved: task",
                        result = "鹈鹕\\nreserved: result",
                        tool = "search",
                        outcome = "鹈鹕\\nreserved: outcome",
                        answer = "鹈鹕\\nreserved: answer"
                    }
                },
                last_request = "鹈鹕\\nreserved: last_request",
                pending = "鹈鹕\\nreserved: pending"
            },
            events = Old56 {
                format = 37,
                turns = 37,
                first_count = 37,
                events = [
                    Old17 {
                        role = "user",
                        kind = "input",
                        name = "鹈鹕\\nreserved: name",
                        text = "鹈鹕\\nreserved: text"
                    }
                ]
            }
        }
    );
    Old57.Rows.insert(
        "row-22",
        Old58 {
            format = 37,
            policy_binding = "鹈鹕\\nreserved: policy_binding",
            turn = 37,
            text = "鹈鹕\\nreserved: text"
        }
    );
    Old59.Rows.insert(
        "row-23",
        Old53 {
            format = 37,
            policy_binding = "鹈鹕\\nreserved: policy_binding",
            work_history = "鹈鹕\\nreserved: work_history",
            workspace = "鹈鹕\\nreserved: workspace",
            path = "鹈鹕\\nreserved: path",
            check = Old41 {
                format = 37,
                phase = "running",
                id = "鹈鹕\\nreserved: id",
                digest = "鹈鹕\\nreserved: digest",
                outcome = "",
                exit_code = ""
            },
            stdout = "鹈鹕\\nreserved: stdout",
            stderr = "鹈鹕\\nreserved: stderr",
            stdout_truncated = true,
            stderr_truncated = true
        }
    );
    Old60.Rows.insert(
        "row-24",
        Old61 {
            format = 37,
            policy_binding = "鹈鹕\\nreserved: policy_binding",
            parent_work_version = "historical-version",
            parent_check_version = "historical-version",
            work = Old44 {
                format = 37,
                phase = "abandoned",
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                path = "鹈鹕\\nreserved: path",
                request = "鹈鹕\\nreserved: request",
                history_version = "historical-version",
                reserved = Old45 {
                    steps = 37,
                    calls = 37,
                    generation = 37,
                    native_tokens = 37
                },
                settled = Some(
                    Old46 {
                        read = Old13 {
                            steps = 37,
                            calls = 37,
                            tokens = 37,
                            tools = 37,
                            scan = 37
                        },
                        edit = Old47 {
                            steps = 37,
                            calls = 37,
                            tokens = 37,
                            native_tokens = 37,
                            boundaries = 37
                        }
                    }
                ),
                summary = "鹈鹕\\nreserved: summary"
            },
            events = Old56 {
                format = 37,
                turns = 37,
                first_count = 37,
                events = [
                    Old17 {
                        role = "user",
                        kind = "input",
                        name = "鹈鹕\\nreserved: name",
                        text = "鹈鹕\\nreserved: text"
                    }
                ]
            }
        }
    );
    Old62.Rows.insert(
        "row-25",
        Old63 {
            format = 37,
            policy_binding = "鹈鹕\\nreserved: policy_binding",
            work = Old44 {
                format = 37,
                phase = "abandoned",
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                path = "鹈鹕\\nreserved: path",
                request = "鹈鹕\\nreserved: request",
                history_version = "historical-version",
                reserved = Old45 {
                    steps = 37,
                    calls = 37,
                    generation = 37,
                    native_tokens = 37
                },
                settled = Some(
                    Old46 {
                        read = Old13 {
                            steps = 37,
                            calls = 37,
                            tokens = 37,
                            tools = 37,
                            scan = 37
                        },
                        edit = Old47 {
                            steps = 37,
                            calls = 37,
                            tokens = 37,
                            native_tokens = 37,
                            boundaries = 37
                        }
                    }
                ),
                summary = "鹈鹕\\nreserved: summary"
            },
            events = Old56 {
                format = 37,
                turns = 37,
                first_count = 37,
                events = [
                    Old17 {
                        role = "user",
                        kind = "input",
                        name = "鹈鹕\\nreserved: name",
                        text = "鹈鹕\\nreserved: text"
                    }
                ]
            }
        }
    );
    Old64.Rows.insert(
        "row-26",
        Old65 {
            format = 37,
            id = "鹈鹕\\nreserved: id",
            target = "鹈鹕\\nreserved: target",
            choice = "abandon"
        }
    );
    Old66.Rows.insert(
        "row-27",
        Old67 {
            format = 37,
            phase = "pending",
            save_id = "鹈鹕\\nreserved: save_id",
            session_key = "鹈鹕\\nreserved: session_key",
            snapshot = Old68 {
                format = 37,
                session_id = "鹈鹕\\nreserved: session_id",
                generation = 37,
                mode = "stub",
                binding = "鹈鹕\\nreserved: binding",
                lifecycle = "recovery-required",
                history = Old69 {
                    events = [
                        Old17 {
                            role = "user",
                            kind = "input",
                            name = "鹈鹕\\nreserved: name",
                            text = "鹈鹕\\nreserved: text"
                        }
                    ],
                    characters = 37,
                    spent = 37,
                    stopped = true
                },
                references = [Old70 {
                    operation = "鹈鹕\\nreserved: operation",
                    phase = "request"
                }],
                operations = [
                    Old71 {
                        id = "鹈鹕\\nreserved: id",
                        status = "unknown",
                        attempts = 37,
                        tokens = 37,
                        scan_bytes = 37
                    }
                ],
                original_caps = Old72 {
                    steps = 37,
                    turn_steps = 37,
                    attempts = 37,
                    tokens = 37,
                    scan_bytes = 37
                },
                current_caps = Old72 {
                    steps = 37,
                    turn_steps = 37,
                    attempts = 37,
                    tokens = 37,
                    scan_bytes = 37
                },
                ledger = Old73 {
                    attempts = 37,
                    tokens = 37,
                    scan_bytes = 37,
                    step_unit = "鹈鹕\\nreserved: step_unit",
                    attempt_unit = "鹈鹕\\nreserved: attempt_unit",
                    token_unit = "鹈鹕\\nreserved: token_unit",
                    scan_unit = "鹈鹕\\nreserved: scan_unit"
                }
            }
        }
    );
    Old74.Rows.insert(
        "row-28",
        Old75 {
            format = 37,
            chain = "鹈鹕\\nreserved: chain",
            turn = 37,
            phase = "intent",
            binding = Old27 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                region = "nomo.tools.edit_file.EditableRoot",
                path = "鹈鹕\\nreserved: path",
                request_digest = "鹈鹕\\nreserved: request_digest",
                before_digest = "鹈鹕\\nreserved: before_digest",
                after_digest = "鹈鹕\\nreserved: after_digest",
                before_bytes = 37,
                after_bytes = 37
            }
        }
    );
    Old76.Rows.insert(
        "row-29",
        Old77 {
            format = 37,
            phase = "admitted",
            chain = "鹈鹕\\nreserved: chain",
            turn = 37,
            id = "鹈鹕\\nreserved: id",
            workspace = "鹈鹕\\nreserved: workspace",
            region = "nomo.tools.edit_file.EditableRoot",
            path = "鹈鹕\\nreserved: path",
            request = "鹈鹕\\nreserved: request",
            allowed = ["鹈鹕\\nreserved: allowed"],
            parent_id = "鹈鹕\\nreserved: parent_id",
            parent_version = "historical-version",
            parent_digest = "鹈鹕\\nreserved: parent_digest",
            maximum = Old78 {
                steps = 37,
                calls = 37,
                generation = 37,
                native_tokens = 37,
                read_tools = 37,
                scan = 37,
                edit_reads = 37,
                edit_read_bytes = 37,
                atomic = 37,
                atomic_bytes = 37
            },
            available = Old78 {
                steps = 37,
                calls = 37,
                generation = 37,
                native_tokens = 37,
                read_tools = 37,
                scan = 37,
                edit_reads = 37,
                edit_read_bytes = 37,
                atomic = 37,
                atomic_bytes = 37
            },
            remaining = Old78 {
                steps = 37,
                calls = 37,
                generation = 37,
                native_tokens = 37,
                read_tools = 37,
                scan = 37,
                edit_reads = 37,
                edit_read_bytes = 37,
                atomic = 37,
                atomic_bytes = 37
            },
            reserved = Old78 {
                steps = 37,
                calls = 37,
                generation = 37,
                native_tokens = 37,
                read_tools = 37,
                scan = 37,
                edit_reads = 37,
                edit_read_bytes = 37,
                atomic = 37,
                atomic_bytes = 37
            },
            work = Some(
                Old79 {
                    format = 37,
                    phase = "summary-unconfirmed",
                    binding = Old27 {
                        id = "鹈鹕\\nreserved: id",
                        workspace = "鹈鹕\\nreserved: workspace",
                        region = "nomo.tools.edit_file.EditableRoot",
                        path = "鹈鹕\\nreserved: path",
                        request_digest = "鹈鹕\\nreserved: request_digest",
                        before_digest = "鹈鹕\\nreserved: before_digest",
                        after_digest = "鹈鹕\\nreserved: after_digest",
                        before_bytes = 37,
                        after_bytes = 37
                    },
                    body = "鹈鹕\\nreserved: body"
                }
            )
        }
    );
    Old80.Rows.insert(
        "row-30",
        Old79 {
            format = 37,
            phase = "summary-unconfirmed",
            binding = Old27 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                region = "nomo.tools.edit_file.EditableRoot",
                path = "鹈鹕\\nreserved: path",
                request_digest = "鹈鹕\\nreserved: request_digest",
                before_digest = "鹈鹕\\nreserved: before_digest",
                after_digest = "鹈鹕\\nreserved: after_digest",
                before_bytes = 37,
                after_bytes = 37
            },
            body = "鹈鹕\\nreserved: body"
        }
    );
    Old81.Counters.insert("row-31", 9007199254740993);
    Old81.Selected.insert("row-32", "鹈鹕\\nreserved: ");
    Old81.Sessions.insert(
        "row-33",
        Old82 {
            id = "鹈鹕\\nreserved: id",
            workspace = "鹈鹕\\nreserved: workspace",
            title = "鹈鹕\\nreserved: title",
            next_event = 9007199254740993,
            first_user = 9007199254740993,
            summary_event = 9007199254740993,
            summary_through = 9007199254740993,
            pending = "鹈鹕\\nreserved: pending",
            ledger = Old83 {
                turns = 9007199254740993,
                compactions = 9007199254740993,
                tools = 9007199254740993,
                generation_allowance = 9007199254740993,
                context_bytes = 37
            }
        }
    );
    Old81.Events.insert(
        "row-34",
        Old84 {
            role = "鹈鹕\\nreserved: role",
            name = "鹈鹕\\nreserved: name",
            call = 9007199254740993,
            chunks = 37,
            complete = true
        }
    );
    Old81.Chunks.insert("row-35", "鹈鹕\\nreserved: ");
    Old85.Jobs.insert(
        "row-36",
        Old86 {
            id = "鹈鹕\\nreserved: id",
            workspace = "鹈鹕\\nreserved: workspace",
            title = "鹈鹕\\nreserved: title",
            kind = "fork",
            source = "鹈鹕\\nreserved: source",
            digest = utf8_encode("鹈鹕\0\n"),
            total = 9007199254740993,
            cursor = 9007199254740993,
            phase = "copying"
        }
    );
    Old87.Jobs.insert(
        "row-37",
        Old88 {
            id = "鹈鹕\\nreserved: id",
            workspace = "鹈鹕\\nreserved: workspace",
            arguments = ["鹈鹕\\nreserved: arguments"],
            phase = "unknown",
            exit_code = Some(37),
            output_bytes = 37,
            parts = 37,
            original = "鹈鹕\\nreserved: original"
        }
    );
    Old87.Parts.insert("row-38", utf8_encode("鹈鹕\0\n"));
    Old89.Counter.insert("row-39", 9007199254740993);
    Old89.Attempts.insert(
        "row-40",
        Old90 {
            id = "鹈鹕\\nreserved: id",
            session = "鹈鹕\\nreserved: session",
            kind = "coding",
            label = "鹈鹕\\nreserved: label",
            phase = "closed_unknown",
            input_event = 9007199254740993,
            through = 9007199254740993,
            result_event = 9007199254740993,
            recovery_event = 9007199254740993
        }
    );
    Old91.Rows.insert(
        "row-41",
        Old92 {
            format = 37,
            chain = "鹈鹕\\nreserved: chain",
            turn = 37,
            phase = "intent",
            root = Old93 {
                version = 37,
                authority = "鹈鹕\\nreserved: authority",
                token = "鹈鹕\\nreserved: token"
            },
            binding = Old27 {
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                region = "nomo.tools.edit_file.EditableRoot",
                path = "鹈鹕\\nreserved: path",
                request_digest = "鹈鹕\\nreserved: request_digest",
                before_digest = "鹈鹕\\nreserved: before_digest",
                after_digest = "鹈鹕\\nreserved: after_digest",
                before_bytes = 37,
                after_bytes = 37
            }
        }
    );
    Old94.Rows.insert(
        "row-42",
        Old95 {
            format = 37,
            root = Old93 {
                version = 37,
                authority = "鹈鹕\\nreserved: authority",
                token = "鹈鹕\\nreserved: token"
            },
            parent_proof = "鹈鹕\\nreserved: parent_proof",
            base = Old77 {
                format = 37,
                phase = "admitted",
                chain = "鹈鹕\\nreserved: chain",
                turn = 37,
                id = "鹈鹕\\nreserved: id",
                workspace = "鹈鹕\\nreserved: workspace",
                region = "nomo.tools.edit_file.EditableRoot",
                path = "鹈鹕\\nreserved: path",
                request = "鹈鹕\\nreserved: request",
                allowed = ["鹈鹕\\nreserved: allowed"],
                parent_id = "鹈鹕\\nreserved: parent_id",
                parent_version = "historical-version",
                parent_digest = "鹈鹕\\nreserved: parent_digest",
                maximum = Old78 {
                    steps = 37,
                    calls = 37,
                    generation = 37,
                    native_tokens = 37,
                    read_tools = 37,
                    scan = 37,
                    edit_reads = 37,
                    edit_read_bytes = 37,
                    atomic = 37,
                    atomic_bytes = 37
                },
                available = Old78 {
                    steps = 37,
                    calls = 37,
                    generation = 37,
                    native_tokens = 37,
                    read_tools = 37,
                    scan = 37,
                    edit_reads = 37,
                    edit_read_bytes = 37,
                    atomic = 37,
                    atomic_bytes = 37
                },
                remaining = Old78 {
                    steps = 37,
                    calls = 37,
                    generation = 37,
                    native_tokens = 37,
                    read_tools = 37,
                    scan = 37,
                    edit_reads = 37,
                    edit_read_bytes = 37,
                    atomic = 37,
                    atomic_bytes = 37
                },
                reserved = Old78 {
                    steps = 37,
                    calls = 37,
                    generation = 37,
                    native_tokens = 37,
                    read_tools = 37,
                    scan = 37,
                    edit_reads = 37,
                    edit_read_bytes = 37,
                    atomic = 37,
                    atomic_bytes = 37
                },
                work = Some(
                    Old79 {
                        format = 37,
                        phase = "summary-unconfirmed",
                        binding = Old27 {
                            id = "鹈鹕\\nreserved: id",
                            workspace = "鹈鹕\\nreserved: workspace",
                            region = "nomo.tools.edit_file.EditableRoot",
                            path = "鹈鹕\\nreserved: path",
                            request_digest = "鹈鹕\\nreserved: request_digest",
                            before_digest = "鹈鹕\\nreserved: before_digest",
                            after_digest = "鹈鹕\\nreserved: after_digest",
                            before_bytes = 37,
                            after_bytes = 37
                        },
                        body = "鹈鹕\\nreserved: body"
                    }
                )
            }
        }
    );
    protocol("trace", Old17 {
        role = "user",
        kind = "input",
        name = "",
        text = "鹈鹕\n"
    });
    protocol(
        "check",
        Old41 {
            format = 1,
            phase = "complete",
            id = "check",
            digest = "digest",
            outcome = "failed",
            exit_code = "37"
        }
    );
    protocol("reference", Old70 {
        operation = "operation",
        phase = "request"
    });
    protocol("continuous", Old22.Rows.get("row-10").unwrap().current);
    protocol(
        "context",
        WireReadContext {
            phase = "aggregate",
            request = "question",
            task = "task",
            result = "result",
            tool = "search",
            outcome = "complete: result",
            allowed = ["a.txt"]
        }
    );
    return 0;
}
