"""
sales_daily_agg · Glue ETL Job
Mart pos_events →    (isbn13 × location_id × channel × date)
Step Functions ETL3  2 · raw_pos_mart   
"""
import sys

import boto3

from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import functions as F

args = getResolvedOptions(
    sys.argv,
    ["JOB_NAME", "MART_BUCKET", "catalog_database"],
)

sc    = SparkContext()
glue  = GlueContext(sc)
spark = glue.spark_session
job   = Job(glue)
job.init(args["JOB_NAME"], args)

POS_PATH    = f"s3://{args['MART_BUCKET']}/mart/sales_fact/"
TARGET_PATH = f"s3://{args['MART_BUCKET']}/mart/sales_daily/"


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


_clean_old_batch_dirs(args["MART_BUCKET"], "mart/sales_fact/")
_clean_old_batch_dirs(args["MART_BUCKET"], "mart/sales_daily/")

pos = spark.read.parquet(POS_PATH)

daily = (
    pos
    .groupBy(
        "sale_date",
        "isbn13",
        F.col("location_id").alias("store_id"),
        "channel",
    )
    .agg(
        F.sum("qty").alias("qty_sold"),
        F.sum("total_price").alias("revenue"),
        F.round(F.when(F.sum("qty") != 0, F.sum("total_price") / F.sum("qty")), 2).alias("avg_price"),
        F.count("tx_id").alias("tx_count"),
        F.max("ts").alias("last_tx_at"),
    )
    .withColumn("aggregated_at", F.current_timestamp())
)

spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")

(
    daily.write
    .mode("overwrite")
    .partitionBy("sale_date")
    .parquet(TARGET_PATH)
)

print(f"[sales_daily_agg] target={TARGET_PATH} rows={daily.count()}")
job.commit()
