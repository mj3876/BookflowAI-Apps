"""
rds_inventory_mart · Glue ETL Job
RDS inventory_snapshot_daily → S3 mart/inventory_daily/ (partitioned by snapshot_date)
Step Functions ETL2
"""
import json
import sys

import boto3
from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import functions as F

args = getResolvedOptions(
    sys.argv,
    ["JOB_NAME", "MART_BUCKET", "RDS_ENDPOINT", "RDS_PORT", "RDS_DBNAME", "RDS_SECRET_ARN"],
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

jdbc_url = f"jdbc:postgresql://{args['RDS_ENDPOINT']}:{args['RDS_PORT']}/{args['RDS_DBNAME']}"

# 가장 최근 snapshot_date 하나만 읽어 S3 해당 파티션에 덮어씀 (dynamic overwrite)
# CURRENT_DATE 대신 MAX(snapshot_date) 사용 — seed 환경에서 오늘 날짜 스냅샷이 없어도 동작
df = (
    spark.read.format("jdbc")
    .option("url", jdbc_url)
    .option("dbtable", "(SELECT * FROM inventory_snapshot_daily WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM inventory_snapshot_daily)) AS t")
    .option("user", creds["username"])
    .option("password", creds["password"])
    .option("driver", "org.postgresql.Driver")
    .load()
)

df = df.select(
    F.col("snapshot_date").cast("date"),
    F.col("isbn13").cast("string"),
    F.col("location_id").cast("int"),
    F.col("on_hand").cast("int"),
    F.col("reserved_qty").cast("int"),
    F.col("safety_stock").cast("int"),
)

spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")

TARGET = f"s3://{args['MART_BUCKET']}/mart/inventory_daily/"


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


_clean_old_batch_dirs(args["MART_BUCKET"], "mart/inventory_daily/")

(
    df.repartition(4, "snapshot_date")
    .write
    .mode("overwrite")
    .partitionBy("snapshot_date")
    .parquet(TARGET)
)

print(f"[rds_inventory_mart] target={TARGET} rows={df.count()}")
job.commit()
