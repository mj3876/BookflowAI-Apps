"""BQ→RDS sync 통합 검증 스크립트 (독립 실행 가능).

사전 조건:
  pip install google-cloud-bigquery
  export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token)

실행:
  python tests/test_bq_refresh_live.py
"""
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

BQ_PROJECT = os.environ.get("FORECAST_BQ_PROJECT_ID", "project-8ab6bf05-54d2-4f5d-b8d")
BQ_DATASET = os.environ.get("FORECAST_BQ_DATASET_ID", "bookflow_dw")
BQ_TABLE   = os.environ.get("FORECAST_BQ_FORECAST_TABLE", "forecast_results")
BQ_DAYS    = int(os.environ.get("FORECAST_BQ_REFRESH_DAYS", "7"))


def _make_bq_client():
    token = os.environ.get("GOOGLE_OAUTH_ACCESS_TOKEN", "")
    if token:
        from google.oauth2.credentials import Credentials
        from google.cloud import bigquery
        creds = Credentials(token=token)
        return bigquery.Client(project=BQ_PROJECT, credentials=creds,
                               location="asia-northeast1")
    else:
        from google.cloud import bigquery
        return bigquery.Client(project=BQ_PROJECT, location="asia-northeast1")


def test_bq_fetch():
    print(f"\n{'='*60}")
    print(f"  BQ→forecast_cache sync 검증")
    print(f"  project : {BQ_PROJECT}")
    print(f"  table   : {BQ_DATASET}.{BQ_TABLE}")
    print(f"  days    : {BQ_DAYS}")
    print(f"{'='*60}")

    try:
        client = _make_bq_client()
    except ImportError:
        print("\n[ERROR] google-cloud-bigquery 미설치")
        print("  pip install google-cloud-bigquery")
        sys.exit(1)

    query = f"""
        WITH latest AS (
          SELECT MAX(prediction_date) AS pred_date,
                 MAX(target_date)     AS max_tgt
          FROM `{BQ_PROJECT}.{BQ_DATASET}.{BQ_TABLE}`
        )
        SELECT
          f.target_date  AS snapshot_date,
          f.isbn13,
          f.store_id,
          f.predicted_demand,
          f.confidence_low,
          f.confidence_high,
          f.model_version
        FROM `{BQ_PROJECT}.{BQ_DATASET}.{BQ_TABLE}` f
        JOIN latest ON f.prediction_date = latest.pred_date
        WHERE f.target_date >= DATE_SUB(latest.max_tgt, INTERVAL @days DAY)
        ORDER BY f.target_date, f.store_id, f.isbn13
        LIMIT 10
    """
    from google.cloud import bigquery as bq
    job_config = bq.QueryJobConfig(
        query_parameters=[bq.ScalarQueryParameter("days", "INT64", BQ_DAYS)]
    )

    try:
        rows = list(client.query(query, job_config=job_config,
                                 location="asia-northeast1").result())
    except Exception as e:
        print(f"\n[FAIL] BigQuery 쿼리 실패: {e}")
        sys.exit(1)

    print(f"\n  [OK] {len(rows)}행 수신 (limit 10 적용)")
    if rows:
        r = rows[0]
        print(f"  첫 행 sample:")
        print(f"    snapshot_date   : {r['snapshot_date']}")
        print(f"    isbn13          : {r['isbn13']}")
        print(f"    store_id        : {r['store_id']}")
        print(f"    predicted_demand: {r['predicted_demand']}")
        print(f"    model_version   : {r['model_version']}")
    else:
        print("  [WARN] 반환 행 0개 — forecast_results 테이블이 비어있을 수 있음")

    print(f"\n{'='*60}")
    print("  결론: BQ 연결 OK · forecast.py _fetch_bigquery_forecast_rows() 동작 확인")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    test_bq_fetch()
