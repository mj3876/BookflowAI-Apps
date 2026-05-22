"""
raw_event_mart - Glue ETL Job
S3 Raw events (GZIP NDJSON) → S3 Mart Parquet

출력: calendar_events/  — 일별 1행 (feature_date 기준 date spine)
  feature_date, is_holiday, holiday_name, season,
  day_of_week, is_weekend, month, event_nearby_days

변경 이력:
  v1: 이벤트 1행 → start_date만 feature_date로 사용 (sparse)
  v2: 날짜 spine 생성 + 이벤트 explode → 연속 일별 calendar (features_build 호환)
"""
import sys
from datetime import date, timedelta

import boto3
from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import functions as F
from pyspark.sql.types import (
    ArrayType,
    BooleanType,
    DateType,
    IntegerType,
    StringType,
    StructField,
    StructType,
)

args = getResolvedOptions(
    sys.argv,
    ["JOB_NAME", "RAW_BUCKET", "MART_BUCKET", "catalog_database"],
)

sc    = SparkContext()
glue  = GlueContext(sc)
spark = glue.spark_session
job   = Job(glue)
job.init(args["JOB_NAME"], args)

SOURCE = f"s3://{args['RAW_BUCKET']}/events/"
TARGET = f"s3://{args['MART_BUCKET']}/mart/calendar_events/"

# 날짜 윈도우: 오늘 기준 과거 60일 ~ 미래 730일 (약 2년치)
WINDOW_PAST   = 60
WINDOW_FUTURE = 730


def _clean_old_batch_dirs(bucket: str, prefix: str) -> None:
    import re
    _hive_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
    s3 = boto3.client("s3")
    paginator = s3.get_paginator("list_objects_v2")
    to_delete = []
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        for cp in page.get("CommonPrefixes", []):
            if not _hive_re.match(cp["Prefix"][len(prefix):]):
                for obj_page in paginator.paginate(Bucket=bucket, Prefix=cp["Prefix"]):
                    for obj in obj_page.get("Contents", []):
                        to_delete.append({"Key": obj["Key"]})
    if to_delete:
        for i in range(0, len(to_delete), 1000):
            s3.delete_objects(Bucket=bucket, Delete={"Objects": to_delete[i:i+1000]})
        print(f"[cleanup] {len(to_delete)} old-format objects removed from s3://{bucket}/{prefix}")


_clean_old_batch_dirs(args["MART_BUCKET"], "mart/calendar_events/")

SCHEMA = StructType([
    StructField("event_id",    StringType(),            True),
    StructField("event_type",  StringType(),            False),
    StructField("title",       StringType(),            True),
    StructField("start_date",  StringType(),            True),
    StructField("end_date",    StringType(),            True),
    StructField("location",    StringType(),            True),
    StructField("isbn13_list", ArrayType(StringType()), True),
    StructField("synced_at",   StringType(),            True),
])

# ── 1. 이벤트 로드 ─────────────────────────────────────────────────────────────
events = (
    spark.read
    .option("compression", "gzip")
    .option("recursiveFileLookup", "true")
    .schema(SCHEMA)
    .json(SOURCE)
    .withColumn("start_date", F.to_date("start_date", "yyyy-MM-dd"))
    .withColumn("end_date",   F.to_date("end_date",   "yyyy-MM-dd"))
    .filter(F.col("event_type").isNotNull() & F.col("start_date").isNotNull())
    # UUID가 달라도 동일 이벤트 중복 제거 (event-sync 매일 재실행 시 누적)
    .dropDuplicates(["event_type", "title", "start_date"])
)

# ── 2. 날짜 spine 생성 ────────────────────────────────────────────────────────
today       = date.today()
spine_start = today - timedelta(days=WINDOW_PAST)
spine_end   = today + timedelta(days=WINDOW_FUTURE)
total_days  = (spine_end - spine_start).days + 1

spine = (
    spark.createDataFrame(
        [(spine_start + timedelta(days=i),) for i in range(total_days)],
        ["feature_date"],
    )
    .withColumn("feature_date", F.col("feature_date").cast(DateType()))
)

print(f"[raw_event_mart] date spine: {spine_start} ~ {spine_end} ({total_days}일)")

# ── 3. 이벤트 날짜 explode: start_date ~ end_date → 1행/일 ───────────────────
exploded = (
    events
    .withColumn(
        "date_seq",
        F.sequence(F.col("start_date"), F.col("end_date")),
    )
    .withColumn("feature_date", F.explode("date_seq"))
    .withColumn(
        "days_into_event",
        F.datediff(F.col("feature_date"), F.col("start_date")).cast(IntegerType()),
    )
    .select("feature_date", "event_type", "title", "days_into_event")
)

# ── 4. 날짜별 집계 (이벤트 여러 개 겹칠 때 holiday 우선) ─────────────────────
event_per_day = (
    exploded
    .withColumn(
        "priority",
        F.when(F.col("event_type") == "holiday",        1)
         .when(F.col("event_type") == "book_fair",       2)
         .when(F.col("event_type") == "publisher_promo", 3)
         .when(F.col("event_type") == "author_signing",  4)
         .otherwise(9),
    )
    .groupBy("feature_date")
    .agg(
        F.max(
            F.when(F.col("event_type") == "holiday", True).otherwise(False)
        ).alias("is_holiday"),
        F.first(
            F.when(F.col("event_type") == "holiday", F.col("title")),
            ignorenulls=True,
        ).alias("holiday_name"),
        F.min("days_into_event").alias("event_nearby_days"),
    )
)

# ── 5. spine + 이벤트 조인 → 연속 일별 calendar ──────────────────────────────
calendar = (
    spine
    .join(event_per_day, on="feature_date", how="left")
    .withColumn("is_holiday",        F.coalesce(F.col("is_holiday"),        F.lit(False)))
    .withColumn("holiday_name",      F.coalesce(F.col("holiday_name"),      F.lit("")))
    .withColumn("event_nearby_days", F.coalesce(F.col("event_nearby_days"), F.lit(0)))
    .withColumn("month",             F.month("feature_date"))
    .withColumn("season",
        F.when(F.month("feature_date").isin(3, 4, 5),   "spring")
         .when(F.month("feature_date").isin(6, 7, 8),   "summer")
         .when(F.month("feature_date").isin(9, 10, 11), "autumn")
         .otherwise("winter"),
    )
    .withColumn("day_of_week", F.dayofweek("feature_date"))
    .withColumn("is_weekend",  F.dayofweek("feature_date").isin(1, 7))
    .select(
        "feature_date",
        "is_holiday",
        "holiday_name",
        "season",
        "day_of_week",
        "is_weekend",
        "month",
        "event_nearby_days",
    )
)

row_count = calendar.count()
print(f"[raw_event_mart] calendar_events rows={row_count} → {TARGET}")

(
    calendar
    .repartition(4)
    .write
    .mode("overwrite")
    .parquet(TARGET)
)

job.commit()
