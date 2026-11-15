# Vendored offline dev dependency: TypeScript 5.7.3

`typescript-5.7.3.tgz` is the exact npm package tarball of TypeScript 5.7.3, the
only `devDependencies` entry of this repository. It was produced offline with
`npm pack` from an already-present local TypeScript 5.7.3 installation; no
network access and no registry lookup was involved.

It is vendored so that this standalone fork can build and typecheck in the
current offline/no-install workspace, and so a fresh checkout can reproduce the
build without fetching anything:

```sh
npm run bootstrap:offline
```

`scripts/bootstrap-offline-deps.mjs` verifies the tarball SHA-256 against
`SHA256SUMS`, then installs it into the repository-local `node_modules` with
`npm install --offline --no-save --no-package-lock --ignore-scripts
--legacy-peer-deps`, which resolves `tsc` from `node_modules/.bin` without any
shell `PATH` setup and without touching the network or any global prefix.
`npm run typecheck`, `npm run build` and `npm run verify` invoke that bootstrap
automatically, so an empty `node_modules` is not a blocker.

On a networked machine the standard `npm install` works as well; the vendored
tarball is only the offline path. `node_modules/` stays gitignored; only the
tarball and its hash are tracked.

- Upstream package: https://www.npmjs.com/package/typescript/v/5.7.3
- License: Apache-2.0 (included inside the tarball)
- Tarball SHA-256: see `SHA256SUMS`
- Repack command used: `npm pack --pack-destination vendor` inside a local
  TypeScript 5.7.3 package directory
