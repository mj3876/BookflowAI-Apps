"""pytest fixtures · inventory-svc 단위 테스트 진입점.

src/ 패키지 import 가능하게 sys.path 보정 + DB env 더미 주입.
"""
import os
import sys
from pathlib import Path

os.environ.setdefault("INVENTORY_RDS_HOST", "localhost")
os.environ.setdefault("INVENTORY_RDS_USER", "test")
os.environ.setdefault("INVENTORY_RDS_PASSWORD", "test")
os.environ.setdefault("INVENTORY_REDIS_HOST", "localhost")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
