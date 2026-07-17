# services/agent/Dockerfile — PathAgent v2 Copilot gateway
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN uv sync
EXPOSE 8010
CMD ["uv", "run", "uvicorn", "agent.gateway.app:create_app", \
     "--factory", "--host", "0.0.0.0", "--port", "8010"]
