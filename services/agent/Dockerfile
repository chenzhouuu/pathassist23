# services/agent/Dockerfile — Copilot gateway
FROM python:3.11-slim
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# The Claude Agent SDK drives the real agent loop by spawning the `claude` CLI — a Node
# program. Install Node.js + the CLI so SdkAgentLoop can run in the container; without them
# the SDK subprocess exits 1 at init and every /turns fails (RFC Risk #1). Headless auth is
# by ANTHROPIC_API_KEY, injected per-turn — no interactive login is needed here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g @anthropic-ai/claude-code \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* \
 && claude --version

# Run as non-root: the claude CLI refuses --dangerously-skip-permissions (which the SDK's
# bypassPermissions passes) under root/sudo. uid 1000 matches the host owner of the bind-
# mounted ./src so the live-reload volume stays readable/writable.
RUN useradd --create-home --uid 1000 app
USER app
ENV HOME=/home/app
WORKDIR /app
COPY --chown=app:app pyproject.toml ./
COPY --chown=app:app src ./src
RUN uv sync
EXPOSE 8010
CMD ["uv", "run", "uvicorn", "agent.gateway.app:create_app", \
     "--factory", "--host", "0.0.0.0", "--port", "8010"]
