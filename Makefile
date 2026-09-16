ENV_FILE ?= .env
export ENV_FILE
export V RC

.PHONY: dev build check test version-check version-set test-release release
dev:
	pnpm dev
build:
	node scripts/release/build.mjs
check:
	pnpm check
	pnpm lint
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
test:
	cargo test --workspace
version-check:
	node scripts/release/repo-version.mjs check
version-set:
	node scripts/release/repo-version.mjs set "$(V)"
test-release:
	node --test scripts/release/*.test.mjs
release:
	node scripts/release/release.mjs
