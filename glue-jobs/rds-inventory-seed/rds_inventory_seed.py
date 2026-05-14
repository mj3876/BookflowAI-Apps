"""
rds_inventory_seed · One-time Glue Job
inventory 테이블 → inventory_snapshot_daily 14일치 생성 (빈 경우에만)
"""
import json
import sys

import boto3
from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import functions as F
from pyspark.sql.types import IntegerType

args = getResolvedOptions(
    sys.argv,
    ["JOB_NAME", "RDS_ENDPOINT", "RDS_PORT", "RDS_DBNAME", "RDS_SECRET_ARN"],
)

sc    = SparkContext()
glue  = GlueContext(sc)
spark = glue.spark_session
job   = Job(glue)
job.init(args["JOB_NAME"], args)

creds = json.loads(
    boto3.client("secretsmanager").get_secret_value(
        SecretId=args["RDS_SECRET_ARN"]
    )["SecretString"]
)

jdbc_url  = f"jdbc:postgresql://{args['RDS_ENDPOINT']}:{args['RDS_PORT']}/{args['RDS_DBNAME']}"
jdbc_opts = {
    "url":      jdbc_url,
    "user":     creds["username"],
    "password": creds["password"],
    "driver":   "org.postgresql.Driver",
}

# 이미 데이터가 있으면 스킵
cnt = (
    spark.read.format("jdbc")
    .options(**jdbc_opts)
    .option("dbtable", "(SELECT COUNT(*) AS cnt FROM inventory_snapshot_daily) AS t")
    .load()
    .first()["cnt"]
)
print(f"[rds_inventory_seed] inventory_snapshot_daily 현재 행 수: {cnt}")

if cnt > 0:
    print("[rds_inventory_seed] 데이터 존재 — 시드 스킵")
else:
    # inventory 테이블 읽기
    inv = (
        spark.read.format("jdbc")
        .options(**jdbc_opts)
        .option("dbtable", "inventory")
        .load()
        .select(
            F.col("isbn13").cast("string"),
            F.col("location_id").cast(IntegerType()),
            F.col("on_hand").cast(IntegerType()).alias("base_on_hand"),
            F.col("reserved_qty").cast(IntegerType()).alias("base_reserved"),
            F.col("safety_stock").cast(IntegerType()),
        )
    )
    print(f"[rds_inventory_seed] inventory 행 수: {inv.count()}")

    # 14일치 날짜 생성 (0=오늘, 13=13일전)
    days = spark.range(14).withColumnRenamed("id", "d")

    seed = (
        inv.crossJoin(days)
        .withColumn("snapshot_date",   F.date_sub(F.current_date(), F.col("d").cast(IntegerType())))
        .withColumn("on_hand",         F.greatest(
            (F.col("base_on_hand")    + (F.rand() * 40 - 20).cast(IntegerType())).cast(IntegerType()), F.lit(0)))
        .withColumn("reserved_qty",    F.greatest(
            (F.col("base_reserved")   + (F.rand() * 4  - 2 ).cast(IntegerType())).cast(IntegerType()), F.lit(0)))
        .withColumn("available",       F.greatest(
            (F.col("on_hand") - F.col("reserved_qty") + (F.rand() * 30 - 10).cast(IntegerType())).cast(IntegerType()), F.lit(0)))
        .withColumn("snapshot_taken_at", F.current_timestamp())
        .select(
            "snapshot_date", "isbn13", "location_id",
            "on_hand", "reserved_qty", "available", "safety_stock",
            "snapshot_taken_at",
        )
    )

    row_count = seed.count()
    print(f"[rds_inventory_seed] 생성할 스냅샷 행 수: {row_count}")

    (
        seed.write.format("jdbc")
        .options(**jdbc_opts)
        .option("dbtable", "inventory_snapshot_daily")
        .mode("append")
        .save()
    )

    print(f"[rds_inventory_seed] 완료 — {row_count}행 적재")

job.commit()
