.PHONY: dev build check test
dev:
	pnpm dev
build:
	pnpm --filter @filo/desktop tauri build
check:
	pnpm check
	pnpm lint
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
test:
	cargo test --workspace
