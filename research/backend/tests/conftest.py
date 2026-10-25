import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CORTEX_DATA_DIR", tempfile.mkdtemp(prefix="cortex2-test-"))
os.environ["DEV_AUTH"] = "1"
# Every local-store write is checked against Firestore's constraints (nested arrays, 1 MiB docs).
os.environ["CORTEX_STRICT_STORE"] = "1"
os.environ.pop("K_SERVICE", None)
os.environ.pop("SERVICE_ROLE", None)
os.environ.pop("HARDWARE_EMAILS", None)
os.environ.pop("OPENAI_API_KEY", None)
os.environ.pop("IBM_QUANTUM_TOKEN", None)
os.environ.pop("IONQ_API_KEY", None)
for k in ("GEMINI_API_KEY", "GEMINI_API_KEY_B", "GEMINI_API_KEY_C", "GEMINI_API_KEY_D", "GEMINI_API_KEY_E", "AGENT_PROVIDERS"):
    os.environ.pop(k, None)
for k in list(os.environ):
    if k.startswith("LIMIT_"):
        os.environ.pop(k)
