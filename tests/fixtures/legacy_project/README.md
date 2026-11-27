# Historical project-state producer

These fixtures preserve the SQLite, journal and process-output formats produced
by the retired Python project runtime at commit `85192b2`. Only migration probes
import them; neither launcher imports this directory. The model/controller/tool
catalogue and Git adapters have been removed, as has the old CLI.

The retained BatchEditor and ProcessService create the actual historical source
format in disposable projects. They are not native implementations, migration
policy or a fallback execution path. Existing migration assertions are unchanged.
