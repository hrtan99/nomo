"""Synthetic observations for actual Etas functions, not a Python policy clone."""


def job(task="hello", context=None, limit=16, spent=0):
    return {"task": task, "context": context or [], "maximum": limit, "spent": spent}


def child(task="hello", context=None, identity="child-1", depth=1, allowance=3):
    return {"id": identity, "depth": depth, "allowance": allowance,
            "task": task, "context": context or []}


def result(text="stub: hello", status="completed", used=1, identity="child-1"):
    return {"id": identity, "status": status, "text": text, "used": used}


def reservation(value=None):
    value = value or job()
    return {"job": value, "child": child(value["task"], value["context"]),
            "ledger": {"maximum": value["maximum"], "spent": value["spent"] + 1, "reserved": 4}}


def case(label, mode="run", value=None, reply=None, accepted=True, status="completed",
         text="stub: hello", used=1, child_task=None, reserved=None):
    return {"label": label, "mode": mode, "job": value or job(),
            "child": child_task or child(), "reply": reply or result(),
            "reservation": reserved or reservation(), "accepted": accepted,
            "status": status, "text": text, "used": used}


def cases():
    values = [
        case("plain-final"),
        case("trimmed-decision-exact-delegation", value=job("  hello  ")),
        case("recall-last-context-A", value=job("recall:user", ["first", "context A"]), text="remembered: context A"),
        case("recall-last-context-B", value=job("recall:user", ["first", "context B"]), text="remembered: context B"),
        case("recall-preserves-spaces", value=job("recall:user", ["  exact context  "]), text="remembered:   exact context  "),
        case("recall-without-context", value=job("recall:user"), status="refused", text="no prior completed context"),
        case("recall-tool-result-is-not-user-context", value=job("recall", ["selected user"]), status="refused", text="no prior completed context"),
        case("actual-echo-final-loop", value=job("tool:echo:child payload"), text="stub received: child payload", used=3),
        case("actual-echo-failure", value=job("tool:echo:fail"), status="refused", text="fake tool failure", used=2),
        case("actual-stub-failure", value=job("stub:fail"), status="refused", text="stub failure"),
        case("unsupported-tool-no-dispatch", value=job("tool:read:payload"), status="refused", text="unknown tool"),
        case("unsupported-spawn-no-child", value=job("tool:spawn:payload"), status="refused", text="unknown tool"),
        case("malformed-tool-missing-value", value=job("tool:echo"), status="refused", text="expected tool:NAME:TEXT (no extra colons)"),
        case("malformed-tool-extra-colon", value=job("tool:echo:a:b"), status="refused", text="expected tool:NAME:TEXT (no extra colons)"),
        case("malformed-tool-empty-name", value=job("tool::x"), status="refused", text="expected tool:NAME:TEXT (no extra colons)"),
        case("task-exact-256", value=job("x" * 256), text="stub: " + "x" * 256),
        case("task-raw-256", value=job(" " * 255 + "x"), text="stub: x"),
        case("context-count-four-aggregate-1024", value=job("recall:user", ["a" * 256, "b" * 256, "c" * 256, "d" * 256]), text="remembered: " + "d" * 256),
        case("context-count-zero"),
        case("context-one-space-is-data", value=job("recall:user", [" "]), text="remembered:  "),
        case("remaining-five-cheap-releases-two", value=job(limit=5)),
        case("remaining-five-echo-uses-all", value=job("tool:echo:x", limit=5), text="stub received: x", used=3),
        case("nonzero-spent-conserved", value=job(limit=16, spent=11)),
        case("nonzero-spent-echo-conserved", value=job("tool:echo:x", limit=16, spent=11), text="stub received: x", used=3),
        case("remaining-six", value=job(limit=16, spent=10)),
        case("remaining-sixteen"),
        case("admit-reserves-before-cheap-child", mode="admit", value=job(limit=5)),
        case("admit-preserves-task-context", mode="admit", value=job("  hello  ", ["a", " b ", "c", "d"], 16, 7)),
    ]
    for label, value in {
        "task-empty": job(""), "task-space-only": job("   "),
        "task-one-over-257": job("x" * 257), "task-raw-one-over-257": job(" " * 256 + "x"),
        "task-slash-command": job("/help"), "task-slash-trimmed": job(" /other "),
        "task-unicode": job("helloé"), "task-delete": job("a\x7f"),
        "context-count-five": job(context=["a"] * 5),
        "context-empty-string": job(context=[""]),
        "context-one-over-257": job(context=["x" * 257]),
        "context-aggregate-one-over-1025": job(context=["a" * 256] * 3 + ["b" * 257]),
        "context-unicode": job(context=["é"]), "context-delete": job(context=["x\x7f"]),
        "limit-zero": job(limit=0), "limit-negative": job(limit=-1),
        "limit-one-over-17": job(limit=17), "spent-negative": job(spent=-1),
        "limit-int-min": job(limit=-2147483648), "limit-int-max": job(limit=2147483647),
        "spent-int-min": job(spent=-2147483648), "spent-int-max": job(spent=2147483647),
        "spent-over-limit": job(limit=5, spent=6),
        "remaining-zero": job(limit=5, spent=5), "remaining-four": job(limit=5, spent=1),
        "remaining-one": job(limit=16, spent=15), "remaining-three": job(limit=16, spent=13),
    }.items():
        values.append(case(label, value=value, accepted=False))
    for code in range(32):
        values.append(case("task-control-" + str(code), value=job("a" + chr(code)), accepted=False))
        values.append(case("context-control-" + str(code), value=job(context=["a" + chr(code)]), accepted=False))
    values += [
        case("child-plain-direct", mode="child"),
        case("child-recall-direct", mode="child", child_task=child("recall:user", ["first", "last"]), text="remembered: last"),
        case("child-echo-direct", mode="child", child_task=child("tool:echo:x"), text="stub received: x", used=3),
        case("child-failed-echo-direct", mode="child", child_task=child("tool:echo:fail"), status="refused", text="fake tool failure", used=2),
        case("child-unsupported-direct", mode="child", child_task=child("tool:command:x"), status="refused", text="unknown tool"),
    ]
    for label, envelope, diagnostic in [
        ("identity", child(identity="child-2"), "invalid child envelope"),
        ("depth-zero", child(depth=0), "invalid child envelope"),
        ("depth-two", child(depth=2), "invalid child envelope"),
        ("allowance-zero", child(allowance=0), "invalid child envelope"),
        ("allowance-two", child(allowance=2), "invalid child envelope"),
        ("allowance-four", child(allowance=4), "invalid child envelope"),
        ("task", child(task=""), "invalid bounded child task"),
        ("context", child(context=["x"] * 5), "invalid selected context"),
    ]:
        values.append(case("child-refuse-" + label, mode="child", child_task=envelope,
                           status="refused", text=diagnostic, used=0))
    values += [
        case("settle-valid-completed-one", mode="settle"),
        case("settle-valid-completed-two", mode="settle", reply=result("two", used=2), text="two", used=2),
        case("settle-valid-completed-three", mode="settle", reply=result("three", used=3), text="three", used=3),
        case("settle-exact-answer-1152", mode="settle", reply=result("x" * 1152), text="x" * 1152),
        case("settle-answer-1151", mode="settle", reply=result("x" * 1151), text="x" * 1151),
        case("settle-refusal-fixed", mode="settle", reply=result("stub failure", "refused"), status="refused", text="stub failure"),
    ]
    for label, reply in {
        "wrong-identity": result(identity="child-2"), "empty-identity": result(identity=""),
        "unknown-status": result(status="success"), "empty-status": result(status=""),
        "zero-usage": result(used=0), "negative-usage": result(used=-1),
        "over-usage": result(used=4), "huge-usage": result(used=2147483647),
        "empty-answer": result(""), "answer-one-over-1153": result("x" * 1153),
        "answer-unicode": result("unvalidated-é"), "answer-delete": result("unvalidated-\x7f"),
        "refusal-untrusted-marker": result("UNVALIDATED_CHILD_MARKER", "refused"),
    }.items():
        values.append(case("settle-invalid-" + label, mode="settle", reply=reply,
                           status="refused", text="invalid child result", used=3))
    for code in range(32):
        values.append(case("settle-invalid-control-" + str(code), mode="settle",
                           reply=result("UNVALIDATED_" + chr(code)), status="refused",
                           text="invalid child result", used=3))
    # Each forged reservation is supplied as typed Etas input and checked by the
    # product settlement function. No fixture repair or child dispatch follows.
    for field, value in [("id", "child-2"), ("depth", 2), ("allowance", 4),
                         ("task", "changed"), ("context", ["injected"])]:
        forged = reservation()
        forged["child"][field] = value
        values.append(case("forged-child-" + field, mode="forged", reserved=forged, accepted=False))
    for field, value in [("maximum", 15), ("spent", 0), ("reserved", 3), ("reserved", 5)]:
        forged = reservation()
        forged["ledger"][field] = value
        label = "limit" if field == "maximum" else field
        values.append(case("forged-ledger-" + label + "-" + str(value), mode="forged", reserved=forged, accepted=False))
    for field, value in [("task", "changed"), ("context", ["injected"]), ("spent", 1), ("maximum", 17)]:
        forged = reservation()
        forged["job"][field] = value
        label = "limit" if field == "maximum" else field
        values.append(case("forged-job-" + label, mode="forged", reserved=forged, accepted=False))
    return values
