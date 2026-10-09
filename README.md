# Poligo Terminal Runner

Standalone WebSocket terminal service for Poligo. The service provides authenticated terminal sessions, pseudo-terminal input/output, workspace file synchronization, resize handling, and automatic session cleanup.

## Render deployment

1. In the Poligo-Terminal Render workspace, create a Web Service from this repository and use the included `render.yaml` Blueprint configuration.
2. Use the Docker runtime and the repository root as the Docker context.
3. Set `RUNNER_TOKEN` to a long, random secret in Render's environment settings. Never commit this value.
4. Keep `TERMINAL_BACKEND=process` for the Render deployment. The process backend runs each shell as a separate unprivileged Unix user and requires the container to start as root so it can create and clean up those users.
5. Verify `/health` returns `terminalBackend: "process"` and `terminalReady: true`.

The service uses the ephemeral filesystem under `/tmp/poligo-terminal-sessions`. Terminal workspaces are not persistent storage: deployments, restarts, or instance suspension can remove active sessions and their files.

## Environment

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP and WebSocket port. Defaults to `10001`. |
| `RUNNER_TOKEN` | Required shared bearer token for all non-health HTTP and WebSocket endpoints. |
| `TERMINAL_BACKEND` | Set to `process` on Render. The optional `docker` backend requires a reachable Docker daemon. |
| `TERMINAL_RUN_ROOT` | Root directory for temporary terminal workspaces. |
| `TERMINAL_MAX_SESSIONS` | Maximum concurrent sessions per instance. Defaults to `4`. |
| `TERMINAL_IDLE_TTL_MS` | Idle-session cleanup interval. Defaults to 30 minutes. |
| `TERMINAL_MAX_LIFETIME_MS` | Maximum lifetime for a session. Defaults to 4 hours. |
| `TERMINAL_MAX_FILES` | Maximum number of project files. Defaults to `200`. |
| `TERMINAL_MAX_PROJECT_BYTES` | Maximum incoming project size. Defaults to approximately 5 MB. |
| `TERMINAL_MAX_WORKSPACE_BYTES` | Maximum live workspace size. Defaults to 384 MiB. |
| `TERMINAL_MAX_WORKSPACE_ENTRIES` | Maximum workspace file and directory entries. Defaults to `20000`. |

The Render Blueprint leaves `RUNNER_TOKEN` unsynchronized so you must enter it explicitly. The Poligo API must use the exact same secret when calling this service.

## API

- `GET /health`: unauthenticated health status only.
- `POST /v1/terminals`: create a terminal session.
- `GET /v1/terminals/:id/files`: retrieve synchronized text files.
- `DELETE /v1/terminals/:id`: close and clean up a session.
- `WS /v1/terminals/:id`: authenticated terminal stream.

Authenticated HTTP and WebSocket requests use `Authorization: Bearer <RUNNER_TOKEN>`. The health route intentionally returns no secret or environment values.

The existing runner server also retains the `/v1/run`, `/v1/runs/:id`, and `/v1/languages` compatibility endpoints. Actual code-execution jobs use Docker through `/var/run/docker.sock`; the normal Render Web Service configuration does not provide a Docker daemon, so those endpoints are not operational in the process-only Render deployment.

**Poligo integration warning:** the current Poligo API uses `RUNNER_URL` for both interactive terminal traffic and language-execution jobs. Do not repoint that shared setting to this service until the API is updated to use a dedicated `TERMINAL_RUNNER_URL` and corresponding terminal token. This avoids unintentionally redirecting language-execution traffic.

## Local validation

Requirements: Docker, Node.js 22, and npm.

```sh
npm install --no-save ws@8.22.0
docker build -t poligo-terminal-runner .
docker run --rm -p 10001:10001 -e PORT=10001 -e RUNNER_TOKEN=local-test-token -e TERMINAL_BACKEND=process -e TERMINAL_RUN_ROOT=/tmp/poligo-terminal-sessions poligo-terminal-runner
```

In another terminal, run:

```sh
RUNNER_TEST_TOKEN=local-test-token RUNNER_TEST_URL=http://127.0.0.1:10001 node tests/e2e/test_terminal_runner_process.mjs
```

The GitHub Actions workflow builds the image and runs the process-backend E2E tests automatically.

## Security boundaries

The process backend uses per-session Unix users, private workspace permissions, path validation, file-count and byte limits, idle cleanup, and session lifetime limits. It is **not** equivalent to a dedicated VM or a kernel sandbox: processes share the service container and its kernel, and the backend does not provide Docker-style per-session network isolation or hard CPU/memory cgroup limits. Do not treat it as a hardened hostile-code execution environment.
