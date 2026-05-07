"""pytest fixtures · intervention-svc 단위 테스트 진입점.

src/ 패키지 import 가능하게 sys.path 보정 + DB env 더미 주입 (settings 가 BaseSettings 라
모듈 import 시점에 env 검증함 → 더미값 필수).
"""
import os
import sys
from pathlib import Path

# settings.py 의 BaseSettings 가 import 시점에 env 요구함
os.environ.setdefault("INTERVENTION_RDS_HOST", "localhost")
os.environ.setdefault("INTERVENTION_RDS_USER", "test")
os.environ.setdefault("INTERVENTION_RDS_PASSWORD", "test")
os.environ.setdefault("INTERVENTION_REDIS_HOST", "localhost")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
