"""
raw_event_mart - Glue ETL Job
S3 Raw events (GZIP NDJSON) -> S3 Mart Parquet (partitioned by event_type)
"""
import sys

import boto3

from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import functions as F
from pyspark.sql.types import (
    ArrayType,
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
    StructField("event_id",    StringType(),              True),
    StructField("event_type",  StringType(),              False),
    StructField("title",       StringType(),              True),
    StructField("start_date",  StringType(),              True),
    StructField("end_date",    StringType(),              True),
    StructField("location",    StringType(),              True),
    StructField("isbn13_list", ArrayType(StringType()),   True),
    StructField("synced_at",   StringType(),              True),
])

df = (
    spark.read
    .option("compression", "gzip")
    .option("recursiveFileLookup", "true")
    .schema(SCHEMA)
    .json(SOURCE)
    .withColumn("synced_at",  F.to_timestamp("synced_at"))
    .withColumn("start_date", F.to_date("start_date", "yyyy-MM-dd"))
    .withColumn("end_date",   F.to_date("end_date",   "yyyy-MM-dd"))
    .filter(F.col("event_type").isNotNull() & F.col("start_date").isNotNull())
    .dropDuplicates(["event_id"])
)

(
    df.write
    .mode("overwrite")
    .partitionBy("event_type")
    .parquet(TARGET)
)

print(f"[raw_event_mart] source={SOURCE} target={TARGET} rows={df.count()}")
job.commit()
