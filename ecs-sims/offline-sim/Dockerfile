FROM public.ecr.aws/docker/library/python:3.12-slim
WORKDIR /app
# Build context = ecs-sims/ root (see buildspec.yml). Sibling _shared/seed_isbns.py 를 COPY.
COPY offline-sim/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY _shared /app/_shared
COPY offline-sim/app.py .
CMD ["python", "app.py"]
