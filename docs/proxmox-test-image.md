# Proxmox test image in the PedanXr fork

Branch: `feat/proxmox-integration`

GitHub Actions runs backend lint/tests, frontend typecheck/tests/build, then builds and smoke-tests the Docker image. If all checks pass on this branch, it publishes to GitHub Container Registry:

- `ghcr.io/pedanxr/gravitylan:proxmox-test` — latest successful test build
- `ghcr.io/pedanxr/gravitylan:proxmox-<full-commit-sha>` — commit-specific tag for a reproducible test

Published platforms: `linux/amd64` and `linux/arm64`. Pull requests and pushes to `main`/`master` do not publish a test image. GitHub Actions uses its built-in `GITHUB_TOKEN`; no Docker Hub credentials are required.

## First publication

In the fork, enable GitHub Actions if GitHub has disabled workflows for the fork. The first push to the feature branch triggers the workflow. Open the Actions run and wait for `publish-test-image` to finish successfully before pulling.

GitHub may create the package as private. To pull without credentials, open your GitHub package's settings and set its visibility to **Public**. Otherwise authenticate on your deployment host using `docker login ghcr.io -u PedanXr` and a GitHub token with `read:packages`; enter the token through Docker's secure prompt, never in the Compose file or chat. Existing organization/package policies may affect this.

## Docker Compose deployment

Run these commands on your own Docker host, in the directory containing your existing Compose file. Substitute its filename and service name if they differ from `docker-compose.yml` and `gravitylan`.

Before the first test, stop the service and take a backup/snapshot of its existing `/app/data` mount, including `gravitylan.db` and `ssh_vault.key`. Keep the backup outside the data directory. Record the old image tag/digest so you can roll back. Start the service again if you are not switching immediately. Do not delete volumes.

The provided `docker-compose.proxmox-test.yml` only overrides the image. Keep your existing Compose file first, so your ports, network mode, environment and data mount remain in effect:

```bash
docker compose -f docker-compose.yml -f docker-compose.proxmox-test.yml config --images
docker compose -f docker-compose.yml -f docker-compose.proxmox-test.yml pull gravitylan
docker compose -f docker-compose.yml -f docker-compose.proxmox-test.yml up -d --no-build gravitylan
docker compose -f docker-compose.yml -f docker-compose.proxmox-test.yml ps
docker compose -f docker-compose.yml -f docker-compose.proxmox-test.yml logs --tail=100 gravitylan
```

`--no-build` also prevents an existing `build:` block from replacing the downloaded image with a local build. For a repeatable test, replace the override's `proxmox-test` tag with the commit-specific tag before pulling. A service named differently needs a matching key in the override file.

If you maintain your own Compose file elsewhere, simply change its existing `image:` line to `ghcr.io/pedanxr/gravitylan:proxmox-test`, then run `docker compose pull <service>` and `docker compose up -d --no-build <service>`. Preserve the existing volume/network settings.

## Functional test

1. Check that the previous devices, login and settings still exist after switching images.
2. Configure **Settings → Proxmox VE**, save, and select **Synchronize now**. See [permissions and guest-agent requirements](proxmox.md).
3. Confirm that both a running VM with a guest agent and an LXC container receive the expected names and IP addresses in GravityLAN. A VM without a guest agent should be skipped without blocking the other guests.
4. Confirm that a custom display name remains unchanged and a later automatic sync runs after five minutes.
5. With a self-signed Proxmox certificate, confirm failure while verification is enabled and success after enabling **Ignore self-signed certificates**. This disables certificate and hostname verification only for that connection.

## Roll back

If using the override, launch with the original Compose file only:

```bash
docker compose -f docker-compose.yml up -d --no-build gravitylan
```

If you edited your own Compose file, restore the original `image:` value first. Stop the service before restoring data from the pre-test backup if necessary. Never use `down -v` for the switch or rollback.

## Upstream contribution

Create the upstream PR only after the local functional test succeeds. Target `SleeperXr/GravityLAN:main`, compare `PedanXr:feat/proxmox-integration`, and include the tested commit/image and real Proxmox results. Review the fork's image-publication workflow and test-image Compose file before opening the PR; remove fork-only deployment material from the final contribution if it is not wanted upstream.
