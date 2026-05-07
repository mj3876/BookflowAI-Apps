"""pytest fixtures · publisher-watcher 단위 테스트."""
import os
import sys
from pathlib import Path

os.environ.setdefault("PUBWATCH_RDS_HOST", "localhost")
os.environ.setdefault("PUBWATCH_RDS_USER", "test")
os.environ.setdefault("PUBWATCH_RDS_PASSWORD", "test")
os.environ.setdefault("PUBWATCH_REDIS_HOST", "localhost")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
