// The CLI runs under Bun, which extends ImportMeta with `dir`/`path`/`file`.
// Declared locally rather than pulling in all of bun-types so the CLI stays
// typecheckable without exposing Bun globals to the rest of the repo.
interface ImportMeta {
  readonly dir: string;
}
