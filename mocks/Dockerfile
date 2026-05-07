FROM public.ecr.aws/docker/library/python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Each mock copies its own src/ directory at deploy time via subdir build context.
# This Dockerfile is shared - per-mock images use --build-arg MOCK_DIR.
ARG MOCK_DIR
COPY ${MOCK_DIR}/src /app/src

EXPOSE 80

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "80"]
