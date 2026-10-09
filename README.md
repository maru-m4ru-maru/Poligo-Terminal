# Poligo Terminal Runner

Standalone authenticated WebSocket terminal service for Poligo. The service is intentionally terminal-only: language execution remains on the existing Poligo runner and continues using `RUNNER_URL`.

## Render deployment

1. In the **Poligo-Terminal** Render workspace, create a Web Service from this repository.
2. Use the included `render.yaml` Blueprint, or select Docker with the repository root as the build context and `Dockerfile` as the Dockerfile.
3. Set `RUNNER_TOKEN` to a strong random secret in Render. Do not commit it or paste it into GitHub.
4. Deploy and inspect `https://poligo-terminal-runner.onrender.com/health`. Do not connect Poligo until the JSON response contains `"terminalReady": true`.
5. In the existing Poligo API service, set `TERMINAL_RUNNER_URL=https://poligo-terminal-runner.onrender.com` and `TERMINAL_RUNNER_TOKEN` to the exact same secret as the Runner's `RUNNER_TOKEN`.
6. Leave the existing `RUNNER_URL` and `RUNNER_TOKEN` values unchanged. They continue to power language execution. The API has separate configuration for terminal traffic, with a fallback to the old settings until the new values are supplied.

The Runner is deployed in a separate Render workspace and is accessed through its public HTTPS/WSS address using a bearer token. Free Render services cannot receive private-network traffic. The bearer token must be kept secret and rotated in both Render services together.

## Security and sandbox behavior

Each terminal runs inside its own chroot filesystem view built from a read-only runtime plus its own writable workspace. Sessions receive distinct unprivileged UIDs. A small native launcher enters the chroot, sets `no_new_privs` before dropping privileges, removes supplementary groups, installs a seccomp filter that denies network socket syscalls and namespace/mount privilege paths, and then starts Bash. The chroot runtime is stripped of setuid/setgid bits. Runner application files, API tokens, and host environment secrets are not passed into the shell. Linux CPU, address-space, process-count, file-size, file-count, and workspace-size limits are applied. Project paths are validated, symlinks are skipped during file collection, session count is capped, and idle and maximum-lifetime cleanup is enabled.

The service fails closed: if the chroot launcher, runtime layout, privilege drop, or seccomp network-denial probe fails, or if `RUNNER_TOKEN` is missing, `/health` returns a non-success status with `terminalReady: false` and new shell sessions are refused. There is no fallback to an unsandboxed shell. Check the live Render health endpoint after deployment before connecting Poligo.

This is defense in depth, not a dedicated VM. It depends on the container kernel and is not a guarantee against kernel vulnerabilities, unsafe kernel interfaces, or exhaustion of the service instance's shared resources. Render's container-wide memory ceiling is shared by all terminal sessions. Render Free instances may restart or spin down, and local files are ephemeral, so live sessions and unsynchronized work can be lost. Terminal commands have no network access by design; package managers that require the internet will not work in the sandbox.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP and WebSocket port; defaults to `10000`. |
| `RUNNER_TOKEN` | Required bearer token for all routes other than `/health`. |
| `TERMINAL_SANDBOX` | The native chroot/seccomp launcher is built into the image. |
| `TERMINAL_RUN_ROOT` | Root for temporary terminal workspaces. |
| `TERMINAL_MAX_SESSIONS` | Maximum active sessions per service instance; defaults to `2`. |
| `TERMINAL_IDLE_TTL_MS` | Idle-session cleanup interval; defaults to 30 minutes. |
| `TERMINAL_MAX_LIFETIME_MS` | Maximum session lifetime; defaults to 4 hours. |
| `TERMINAL_MAX_FILES` | Maximum number of project files; defaults to `200`. |
| `TERMINAL_MAX_PROJECT_BYTES` | Maximum incoming project size; defaults to about 5 MB. |
| `TERMINAL_MAX_WORKSPACE_BYTES` | Maximum live workspace size; defaults to 128 MiB. |
| `TERMINAL_MAX_WORKSPACE_ENTRIES` | Maximum workspace file and directory entries; defaults to `5000`. |
| `MAX_REQUEST_BYTES` | Maximum HTTP request body; defaults to about 8 MB. |

The Render Blueprint leaves `RUNNER_TOKEN` unsynchronized so it has to be configured in the Render dashboard. The token must match `TERMINAL_RUNNER_TOKEN` in the Poligo API.

## API

- `GET /health`: health and sandbox readiness, without revealing secret values.
- `POST /v1/terminals`: create a terminal session from a project ID and text files.
- `GET /v1/terminals/:id/files`: retrieve the session's synchronized text files.
- `DELETE /v1/terminals/:id`: stop and remove a session.
- `WS /v1/terminals/:id`: PTY input/output and resize events.

Except for `GET /health`, HTTP and WebSocket endpoints require `Authorization: Bearer <RUNNER_TOKEN>`. End-user authentication and project ownership checks remain the responsibility of the Poligo API; this service is intended to be called only by that trusted API.

## Local test

Requirements: Docker, Node.js 22, npm, and a Linux host/container that permits chroot, UID/GID changes, and seccomp filters.

```sh
npm run check
npm install --no-save ws@8.22.0
docker build -t poligo-terminal-runner .
docker run --rm -p 10000:10000 -e PORT=10000 -e RUNNER_TOKEN=local-test-token -e TERMINAL_RUN_ROOT=/tmp/poligo-terminal-sessions poligo-terminal-runner
```

In another terminal:

```sh
RUNNER_TEST_TOKEN=local-test-token RUNNER_TEST_URL=http://127.0.0.1:10000 node tests/e2e/test_runner.mjs
```

The live Render readiness probe is authoritative for whether the deployment can provide the expected isolation.

## Render Free plan note

Render Free web services spin down after 15 minutes without inbound HTTP requests or WebSocket messages, do not have persistent disks, and share a workspace-level monthly included-hours allowance. Active terminal sessions and unsynchronized file changes can disappear on a restart or spin-down. Do not add a keep-alive loop merely to preserve idle sessions; that could keep the service running and consume free instance hours.

## CI

The `.github/workflows/terminal-e2e.yml` workflow checks JavaScript syntax, builds the Docker image, confirms sandbox readiness, and exercises authentication, namespace boundaries, network isolation, Node.js/Python command execution, PTY input/output, Ctrl+C, project file synchronization, and session cleanup.
