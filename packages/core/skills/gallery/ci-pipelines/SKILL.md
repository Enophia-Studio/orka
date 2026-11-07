---
name: ci-pipelines
description: Continuous integration and delivery pipelines (GitHub Actions, GitLab CI, Azure Pipelines and similar): building, testing, caching, releasing and securing them. Use when creating or fixing a CI workflow or a failing pipeline run.
license: MIT
---

# CI pipelines

## Fit the project
- Find what exists (`.github/workflows/`, `.gitlab-ci.yml`, `azure-pipelines.yml`) and the commands developers run locally (package.json scripts, a Makefile). CI runs those same commands rather than a second definition of the build.
- Match the runtime versions the project declares (`engines`, `.nvmrc`, `global.json`, `pyproject.toml`) and test on the operating systems it supports.

## A good pipeline
- Fast feedback first: install, lint and type-check, unit tests, then the slower integration or end-to-end jobs. Fail early and show the failing command's output.
- Deterministic installs from the lockfile (`npm ci`, `pip install` with hashes, `dotnet restore --locked-mode`), with a dependency cache keyed on the lockfile's hash.
- Run on pull requests and on the main branch; cancel superseded runs of the same branch (`concurrency` with `cancel-in-progress`).
- A matrix only for what matters (supported versions and systems), not every combination.
- Keep artifacts that help debugging (test reports, screenshots of failed UI tests, logs) for a short time.

## Security
- Least privilege: set `permissions:` explicitly (start from `contents: read`) and grant more per job only where needed.
- Pin third-party actions to a full commit SHA; read what an action does before adding it.
- Secrets live only in the platform's secret store and go only to the steps that need them; never print them, and never expose them to runs triggered from forks (`pull_request_target` runs with secrets, so do not check out untrusted code there).
- Never paste untrusted input (issue titles, branch names, PR bodies) straight into a shell script; pass it through environment variables.

## Releases
- Build once and promote the same artifact; trigger releases from tags, with a changelog; sign and publish in a separate job with its own environment and approval rules.

## Fixing a red build
- Read the first error in the log, not the last. Reproduce it locally with the same command and versions. Tell a flaky test (passes on rerun, depends on timing or order) from a real failure, and fix the flakiness instead of quietly adding retries.
- Check the workflow syntax before pushing (actionlint or the platform's linter) and say what could not be verified because it only runs in CI.
