import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("CORTEX_DATA_DIR", tempfile.mkdtemp(prefix="cortex2-test-"))
os.environ["DEV_AUTH"] = "1"
os.environ.pop("K_SERVICE", None)
os.environ.pop("OPENAI_API_KEY", None)
os.environ.pop("IBM_QUANTUM_TOKEN", None)
for k in ("GEMINI_API_KEY", "GEMINI_API_KEY_B", "GEMINI_API_KEY_C", "AGENT_PROVIDERS"):
    os.environ.pop(k, None)
