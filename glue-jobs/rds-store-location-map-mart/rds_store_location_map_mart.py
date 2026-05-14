"""
rds_store_location_map_mart · Glue ETL Job
RDS locations → store_location_map 파생 → S3 mart/store_location_map/ (full overwrite)

파생 규칙:
  STORE_OFFLINE: store_id = location_id, inventory_location_id = location_id
  STORE_ONLINE:  store_id = location_id, inventory_location_id = WH의 location_id (wh_id 기준 self-join)
                 WH location이 없으면 wh_id를 그대로 사용

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

locs = (
    spark.read.format("jdbc")
    .option("url", jdbc_url)
    .option("dbtable", "(SELECT location_id, location_type, wh_id, is_virtual FROM locations WHERE active = TRUE) AS t")
    .option("user", creds["username"])
    .option("password", creds["password"])
    .option("driver", "org.postgresql.Driver")
    .load()
    .withColumn("location_id", F.col("location_id").cast("int"))
    .withColumn("wh_id",       F.col("wh_id").cast("int"))
    .withColumn("is_virtual",  F.col("is_virtual").cast("boolean"))
)

# WH location_id per wh_id (WH 타입이 있을 경우)
wh_locs = (
    locs
    .filter(F.col("location_type") == "WH")
    .select(
        F.col("wh_id").alias("wh_key"),
        F.col("location_id").alias("wh_location_id"),
    )
)

stores = locs.filter(F.col("location_type").isin("STORE_OFFLINE", "STORE_ONLINE"))

# STORE_ONLINE은 WH 재고 참조, STORE_OFFLINE은 자기 location
df = (
    stores
    .join(wh_locs, stores["wh_id"] == wh_locs["wh_key"], how="left")
    .withColumn(
        "inventory_location_id",
        F.when(
            F.col("is_virtual") & F.col("wh_location_id").isNotNull(),
            F.col("wh_location_id"),
        ).when(
            F.col("is_virtual"),
            F.col("wh_id"),  # WH location 없으면 wh_id 직접 사용
        ).otherwise(
            F.col("location_id"),
        ),
    )
    .select(
        F.col("location_id").alias("store_id"),
        F.col("location_id"),
        F.col("inventory_location_id").cast("int"),
    )
)

TARGET = f"s3://{args['MART_BUCKET']}/mart/store_location_map/"


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


_clean_old_batch_dirs(args["MART_BUCKET"], "mart/store_location_map/")

df.write.mode("overwrite").parquet(TARGET)

print(f"[rds_store_location_map_mart] target={TARGET} rows={df.count()}")
job.commit()
