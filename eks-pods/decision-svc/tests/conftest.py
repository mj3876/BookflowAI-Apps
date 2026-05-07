"""pytest fixtures · decision-svc 단위 테스트 진입점."""
import os
import sys
from pathlib import Path

os.environ.setdefault("DECISION_RDS_HOST", "localhost")
os.environ.setdefault("DECISION_RDS_USER", "test")
os.environ.setdefault("DECISION_RDS_PASSWORD", "test")
os.environ.setdefault("DECISION_REDIS_HOST", "localhost")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
