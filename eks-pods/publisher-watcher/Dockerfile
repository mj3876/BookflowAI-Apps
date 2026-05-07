FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY src /app/src

# CronJob entrypoint - exits after one polling round, k8s respawns per schedule
CMD ["python", "-m", "src.poll"]
