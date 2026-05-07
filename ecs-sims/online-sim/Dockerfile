FROM public.ecr.aws/docker/library/python:3.12-slim
WORKDIR /app
COPY online-sim/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY _shared /app/_shared
COPY online-sim/app.py .
CMD ["python", "app.py"]
