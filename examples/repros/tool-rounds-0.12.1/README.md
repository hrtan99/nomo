# Native tool-round limit

The normal synthetic end-to-end acceptance hit this limit on official ETAS 0.12.1: nine model requests, then `model tool-call loop exceeded the maximum number of rounds`. Native reading, approved editing, a successful command check, Git status/diff/init/branch/switch had already run; commit/log/branch listing and final completion had not run.

`UPSTREAM_ISSUE.md` records the observed failure and exact compiler graph. The small standalone example here is a reduced reproduction recipe, not an additional executed acceptance run:

```sh
python3 server.py
# In a second terminal, using the same host network namespace:
SYNTHETIC_KEY=synthetic etas run . --allow-effects
```

No real credentials, provider calls or compiler patches are needed. Nomo does not replace the native loop with Python or split the requested task merely to evade this limit.

Upstream report: https://github.com/etas-project/etas/issues/79.
