# Mindi

Mindi is Josh's AI system. This repository is a working fork of
[mindi-dev/mindi-stack](https://github.com/mindi-dev/mindi-stack), starting with a
minimal Turborepo and pnpm workspace foundation.

## Getting started

Use Node.js 24 LTS (`nvm install && nvm use`) and pnpm 12.6.0, pinned in
`package.json`. If pnpm is unavailable, install that version using
[the pnpm installation instructions](https://pnpm.io/installation).

```sh
pnpm install
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @mindi/hello start
```

The example prints `Hello, Mindi!`. `pnpm dev` watches TypeScript in the app and
core package; run the app separately with the `start` command above.

## Layout

- `apps/hello`: tiny Node.js app consuming `@mindi/core`.
- `packages/core`: shared greeting function and Node test runner tests.
- `packages/typescript-config`: strict shared TypeScript configuration.
- `packages/eslint-config`: shared ESLint flat configuration.
- `turbo.json`: dependency-aware build, dev, lint, typecheck and test tasks.
- `.github/workflows/ci.yml`: frozen install and checks for PRs and pushes to main.

Build outputs live in each package's `dist/`; Turborepo caches builds in
`.turbo/`. Both are ignored by Git. All workspaces are private to prevent
accidental package publication.

## Adding an app or package

1. Create `apps/<name>` or `packages/<name>` with a private `package.json` and
   unique `@mindi/<name>` name. The workspace globs pick it up automatically.
2. Copy the small app or core package as a starting point. Add
   `@mindi/typescript-config` and `@mindi/eslint-config` as `workspace:*` dev
   dependencies, extend the shared TS base and re-export the ESLint config.
3. Add the applicable `build`, `dev`, `lint`, `typecheck` and `test` scripts.
   Set package exports to built files when another workspace consumes it, and
   declare that dependency with `workspace:*` so Turbo orders builds correctly.
4. Run `pnpm install` and the checks above; commit the updated lockfile.

`apps/agent-box` comes next in [HEX-85](/HEX/issues/HEX-85)
and is intentionally outside this scaffold.

Never commit secrets or `.env` files. CI needs no application secrets.

## License

[MIT](LICENSE).
