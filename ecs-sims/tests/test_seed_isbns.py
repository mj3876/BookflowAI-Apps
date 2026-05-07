"""ECS sim 1000 ISBN pool 단위 테스트."""
import sys
from pathlib import Path
import random

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from _shared.seed_isbns import SEED_ISBNS


def test_pool_size_is_1000():
    assert len(SEED_ISBNS) == 1000


def test_isbns_unique():
    assert len(set(SEED_ISBNS)) == 1000


def test_isbn13_format():
    """모두 13자리 숫자 (algorithmic ISBN13)."""
    for isbn in SEED_ISBNS[:50]:  # spot check 50
        assert len(isbn) == 13 and isbn.isdigit()


def test_sample_seed_42_deterministic():
    """seed=42 random.sample 이 빌드마다 동일 결과."""
    rng1 = random.Random(42)
    s1 = rng1.sample(SEED_ISBNS, 1000)
    rng2 = random.Random(42)
    s2 = rng2.sample(SEED_ISBNS, 1000)
    assert s1 == s2


def test_sample_size_1000():
    rng = random.Random(42)
    sampled = rng.sample(SEED_ISBNS, min(1000, len(SEED_ISBNS)))
    assert len(sampled) == 1000
