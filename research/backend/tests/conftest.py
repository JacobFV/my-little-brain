import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["CORTEX_DATA_DIR"] = tempfile.mkdtemp(prefix="cortex2-test-")   # never the developer's local store
os.environ["DEV_AUTH"] = "1"
# Every local-store write is checked against Firestore's constraints (nested arrays, 1 MiB docs).
os.environ["CORTEX_STRICT_STORE"] = "1"
os.environ.pop("K_SERVICE", None)
os.environ.pop("CORTEX_STORE", None)
os.environ.pop("CORTEX_TASKS", None)
os.environ.pop("AGENT_ORACLE", None)
os.environ.pop("SERVICE_ROLE", None)
os.environ.pop("HARDWARE_QUOTAS", None)
for k in list(os.environ):
    # no live model, QPU or vendor credentials in tests, whatever the developer's shell exports
    if k.startswith(("GEMINI_API_KEY", "OPENAI_API_KEY", "IBM_QUANTUM", "IONQ_", "LIMIT_")) or k == "AGENT_PROVIDERS":
        os.environ.pop(k, None)

# Jobs enqueued by any test (not only those that import the app) run on local threads.
from cortex2 import runner, tasks  # noqa: E402

tasks.set_local_handler(runner.handle_task)
