# =============================================================================
# TraceRoot Development
# =============================================================================

PROD_COMPOSE := docker compose -f docker-compose.prod.yml

.PHONY: install-hooks dev dev-lite dev-autoreload dev-reset prod prod-lite prod-reset seed seed-reset

## Install repository git hooks for contributors.
install-hooks:
	uv run pre-commit install

## Start developing. Handles everything: deps, infra, migrations, tmux launch.
## Idempotent - safe to run repeatedly. Reattaches if already running.
dev: install-hooks
	uv run python tmux_tools/launcher.py

## Same as dev, but with auto-reload for backend services (REST API + Celery).
dev-autoreload: install-hooks
	uv run python tmux_tools/launcher.py --autoreload

## Windows contributors: full dev env without tmux requirement.
dev-lite: install-hooks
	@echo "Starting TraceRoot at http://localhost:3000 - Ctrl+C to stop"
	$(PROD_COMPOSE) up --build

## Nuclear reset: kill tmux, destroy all containers/volumes/deps. Run `make dev` to start again.
dev-reset:
	uv run python tmux_tools/launcher.py --reset

# --- Production (Docker) ---------------------------------------------------

## Start all services in Docker with tmux log viewer (builds on first run).
prod:
	uv run python tmux_tools/launcher.py --prod

## Self-hosting on any platform (Windows, CI, no tmux). Docker Desktop only.
prod-lite:
	@echo "Starting TraceRoot at http://localhost:3000 - Ctrl+C to stop"
	$(PROD_COMPOSE) up --build

## Nuclear reset: stop containers, remove volumes, built images, and orphaned sandboxes.
prod-reset:
	uv run python tmux_tools/launcher.py --prod-reset

# --- Seed local stack -------------------------------------------------------

## Populate the local stack with synthetic projects, users, traces, spans,
## detectors, and detector runs/findings. Requires `make dev` already running.
##
## Two-phase workflow (re-runs are first-class, not exceptional):
##   1. `make seed`                        — creates seed workspaces + projects
##   2. Sign up in the UI                  — your account exists in Postgres
##   3. `SEED_ATTACH_USER_EMAIL=you@x make seed`
##                                         — attaches your account to seed workspaces
##   4. (Optional) Create a detector in UI, then re-run step 3 to backfill its
##      detector_runs and detector_findings. The seed discovers detectors via
##      a Postgres scope predicate (workspace.is_seed=TRUE OR detector.is_seed=TRUE),
##      so UI-created detectors in seed workspaces get backfilled too.
##
## Idempotent — safe to run repeatedly. Refuses to run against non-local CH.
seed:
	cd frontend && pnpm --filter @traceroot/seed run seed

## Remove only seed-prefixed rows from Postgres + ClickHouse. Real data is untouched.
seed-reset:
	cd frontend && pnpm --filter @traceroot/seed run seed:reset
