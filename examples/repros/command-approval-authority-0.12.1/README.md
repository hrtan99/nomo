# Command approval authority snapshot

The positive native batch/undo integration completed its real file operations, but its approval audit failed: the actual Command Host requests and trace carried approval counts from before their current successful approvals. Every command did prompt. This observation does not establish an approval bypass.

`UPSTREAM_ISSUE.md` preserves the observed trace sequence and official compiler identity. The standalone source here is a reduced recipe, not a separately executed run:

```sh
etas run . --allow-effects --trace-out trace.json
# Answer yes to each synthetic echo request, then inspect Approval.request and Command.run.
```

No model, credentials, private input or local compiler patch is needed. Nomo does not weaken the approval audit to treat the stale snapshot as a current grant.

Upstream report: https://github.com/etas-project/etas-interpreter/issues/102.
