"""
raw_sns_mart · Glue ETL Job
S3 Raw sns (GZIP NDJSON) → S3 Mart Parquet (partitioned by mention_date)
Job bookmark enabled →   
"""
import sys

import boto3

from awsglue.context import GlueContext
from awsglue.job import Job
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
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

SOURCE = f"s3://{args['RAW_BUCKET']}/sns/"
TARGET = f"s3://{args['MART_BUCKET']}/mart/sns_mentions/"


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


_clean_old_batch_dirs(args["MART_BUCKET"], "mart/sns_mentions/")

SNS_SCHEMA = StructType([
    StructField("isbn13",        StringType(),  False),
    StructField("platform",      StringType(),  True),
    StructField("content",       StringType(),  True),
    StructField("sentiment",     StringType(),  True),
    StructField("mention_count", IntegerType(), True),
    StructField("is_spike_seed", BooleanType(), True),
    StructField("collected_at",  StringType(),  True),
    StructField("is_synthetic",  BooleanType(), True),
])

df = (
    spark.read
    .option("compression", "gzip")
    .option("recursiveFileLookup", "true")
    .schema(SNS_SCHEMA)
    .json(SOURCE)
)

df = (
    df
    .withColumn("created_at",   F.to_timestamp("collected_at"))
    .withColumn("mention_date", F.to_date("collected_at"))
    .filter(F.col("isbn13").isNotNull())
)

spark.conf.set("spark.sql.sources.partitionOverwriteMode", "dynamic")

(
    df.write
    .mode("overwrite")
    .partitionBy("mention_date")
    .parquet(TARGET)
)

print(f"[raw_sns_mart] source={SOURCE} target={TARGET} rows={df.count()}")
job.commit()
