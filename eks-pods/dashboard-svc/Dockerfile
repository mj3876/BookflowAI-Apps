### Stage 1: Vite build (React + Tailwind + Router) ###
FROM public.ecr.aws/docker/library/node:20-alpine AS web
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/tsconfig.json web/vite.config.ts web/tailwind.config.js web/postcss.config.js web/index.html ./
COPY web/src ./src
RUN npm run build

### Stage 2: FastAPI + StaticFiles ###
FROM public.ecr.aws/docker/library/python:3.12-slim
WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY src /app/src
COPY --from=web /web/dist /app/static

EXPOSE 80
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "80"]
