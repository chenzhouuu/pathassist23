# services/pathagent/Dockerfile
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN uv sync --no-dev
ENV PATHAGENT_REDIS_URL=redis://redis:6379/0
EXPOSE 8000
CMD ["uv", "run", "uvicorn", "pathagent.gateway.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
