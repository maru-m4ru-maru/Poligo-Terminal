# Poligo Terminal Runner

Standalone authenticated WebSocket terminal service for Poligo. The service is intentionally terminal-only: language execution remains on the existing Poligo runner and continues using `RUNNER_URL`.

## Render deployment

**Deploy the published image, not a Git-backed Render Docker build.** The sandbox needs character-device nodes inside its chroot. Render currently rejects `mknod` both during image builds and at runtime, so a Git-backed deployment cannot initialize the sandbox and must remain unavailable.

### Build and publish the image

The `.github/workflows/publish-runner-image.yml` workflow builds the image with the required device nodes, checks readiness, runs terminal E2E tests, and publishes the tested image to:

```text
ghcr.io/maru-m4ru-maru/poligo-terminal-runner:main
```

A commit-specific tag is published alongside `main`. The workflow only pushes an image after its sandbox and E2E checks pass. The token is supplied at runtime and is not embedded in the image.

Make the GitHub Container Registry package public if Render should pull it without registry credentials. Package settings: https://github.com/users/maru-m4ru-maru/packages/container/poligo-terminal-runner/settings. If you keep the package private, configure a GitHub Container Registry credential in Render with a token that has `read:packages`.

### Create the Render service

1. In the Render dashboard, select **New + → Web Service → Existing Image**. Do not select the Git repository as the source.
2. Use `ghcr.io/maru-m4ru-maru/poligo-terminal-runner:main` as the image URL.
3. Use the Oregon region and Free plan, matching the existing Poligo services.
4. Set the health check path to `/health`. Leave the Docker command unset so the image's `CMD` starts the server.
5. Set `RUNNER_TOKEN` to a strong random secret in the Render environment dashboard. Do not commit it or paste it into GitHub.
6. Deploy and check the actual URL Render assigns. The health endpoint must return HTTP 200 and JSON containing `"terminalReady": true` before the service is connected to Poligo.

In the existing Poligo API service, set:

- `TERMINAL_RUNNER_URL` to the new image-backed Render service URL.
- `TERMINAL_RUNNER_TOKEN` to the exact same secret as the image-backed service's `RUNNER_TOKEN`.

Leave the existing `RUNNER_URL` and `RUNNER_TOKEN` values unchanged. They still power language execution. Terminal traffic has separate configuration so it can use a separate runner and secret.

Image-backed Render services do not automatically redeploy when a registry tag changes. After the publisher workflow pushes a newer `main` image, manually deploy the latest image reference in Render. Use a commit-specific image tag when you need to pin a specific tested build.

## Security and sandbox behavior

Each terminal runs inside its own prebuilt chroot filesystem slot. The two slots are baked into the image so Render does not need runtime hard links or device-node creation. Each slot contains a read-only runtime and a separate writable workspace and temporary directories. Active sessions receive distinct unprivileged UIDs; the service supports at most two simultaneous sessions per instance. A small native launcher enters the chroot, sets `no_new_privs` before dropping privileges, removes supplementary groups, installs a seccomp filter that denies network socket syscalls and namespace/mount privilege paths, and then starts Bash. The chroot runtime is stripped of setuid/setgid bits. Runner application files, API tokens, and host environment secrets are not passed into the shell. Linux CPU, address-space, process-count, file-size, file-count, and workspace-size limits are applied. Project paths are validated, symlinks are skipped during file collection, session count is capped, and idle and maximum-lifetime cleanup is enabled.

The service fails closed: if the chroot launcher, runtime layout, privilege drop, or seccomp network-denial probe fails, or if `RUNNER_TOKEN` is missing, `/health` returns a non-success status with `terminalReady: false` and new shell sessions are refused. There is no fallback to an unsandboxed shell. Check the live Render health endpoint after deployment before connecting Poligo.

This is defense in depth, not a dedicated VM. It depends on the container kernel and is not a guarantee against kernel vulnerabilities, unsafe kernel interfaces, or exhaustion of the service instance's shared resources. Render's container-wide memory ceiling is shared by all terminal sessions. Render Free instances may restart or spin down, and local files are ephemeral, so live sessions and unsynchronized work can be lost. Terminal commands have no network access by design; package managers that require the internet will not work in the sandbox.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP and WebSocket port; defaults to `10000`. |
| `RUNNER_TOKEN` | Required bearer token for all routes other than `/health`. |
| `TERMINAL_RUN_ROOT` | Temporary scratch directory used by sandbox-readiness probes. |
| `TERMINAL_MAX_SESSIONS` | Maximum active sessions per service instance; defaults to `2`. |
| `TERMINAL_IDLE_TTL_MS` | Idle-session cleanup interval; defaults to 30 minutes. |
| `TERMINAL_MAX_LIFETIME_MS` | Maximum session lifetime; defaults to 1 hour. |
| `TERMINAL_MAX_FILES` | Maximum number of project files; defaults to `200`. |
| `TERMINAL_MAX_PROJECT_BYTES` | Maximum incoming project size; defaults to about 5 MB. |
| `TERMINAL_MAX_WORKSPACE_BYTES` | Maximum live workspace size; defaults to 128 MiB. |
| `TERMINAL_MAX_WORKSPACE_ENTRIES` | Maximum workspace file and directory entries; defaults to `5000`. |
| `MAX_REQUEST_BYTES` | Maximum HTTP request body; defaults to about 8 MB. |

## API

- `GET /health`: health and sandbox readiness, without revealing secret values.
- `POST /v1/terminals`: create a terminal session from a project ID and text files.
- `GET /v1/terminals/:id/files`: retrieve the session's synchronized text files.
- `DELETE /v1/terminals/:id`: stop and remove a session.
- `WS /v1/terminals/:id`: PTY input/output and resize events.

Except for `GET /health`, HTTP and WebSocket endpoints require `Authorization: Bearer <RUNNER_TOKEN>`. End-user authentication and project ownership checks remain the responsibility of the Poligo API; this service is intended to be called only by that trusted API.

## Local test

Requirements: Docker, Node.js 22, npm, and a Linux host/container that permits chroot, UID/GID changes, and seccomp filters.

The build argument is required to include device nodes and the two prebuilt isolated chroot slots in the image:

```sh
npm run check
npm install --no-save ws@8.22.0
docker build --build-arg INCLUDE_SANDBOX_DEVICES=true -t poligo-terminal-runner .
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

The `.github/workflows/terminal-e2e.yml` workflow checks syntax and E2E behavior. The `.github/workflows/publish-runner-image.yml` workflow builds the image with the sandbox devices, verifies readiness, runs the same E2E suite, and only then pushes the tested image to GHCR.
