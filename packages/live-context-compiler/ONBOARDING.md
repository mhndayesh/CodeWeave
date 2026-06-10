# User Onboarding

This guide gets a new user from a clean checkout to a usable context graph.

## Requirements

- Node.js 22.13 or newer
- npm
- A source repository to index

## First Run

```bash
npm install
npm run typecheck
npm test
```

Initialize and index a repository:

```bash
npx tsx src/cli.ts init --root /path/to/repo
npx tsx src/cli.ts index --root /path/to/repo
npx tsx src/cli.ts stats --root /path/to/repo
```

Generate your first slice:

```bash
npx tsx src/cli.ts slice --root /path/to/repo --query login --policy impact
```

Useful policies:

| Policy | Use it for |
|--------|------------|
| `minimal` | Quick symbol lookup |
| `function_edit` | Editing one function and its direct dependencies |
| `endpoint_edit` | API route changes |
| `schema_edit` | Schema, migration, and table access changes |
| `impact` | Broader change impact analysis |

## Daily Workflow

```bash
npx tsx src/cli.ts watch --root /path/to/repo
npx tsx src/cli.ts query --root /path/to/repo --query AuthService
npx tsx src/cli.ts slice --root /path/to/repo --query AuthService --policy function_edit
```

If files changed while the watcher was not running:

```bash
npx tsx src/cli.ts invalidate --root /path/to/repo --file src/auth.ts
npx tsx src/cli.ts reindex --root /path/to/repo
```

## Verification Tiers

Edges carry numeric evidence tiers:

| Tier | Meaning |
|------|---------|
| `0` | Unresolved |
| `1` | Annotation only |
| `2` | Pattern matched by a regex indexer |
| `3` | Verified by static bridge logic |
| `4` | Verified by the TypeScript compiler/type checker |
| `5` | Verified by runtime traces or coverage |

Prefer tier 4 or 5 edges for high-confidence edits.

## Health Checks

```bash
npm run check
npm run build
npm audit
npm run bench
```

For a CLI smoke test, index the bundled fixture:

```bash
rm -f /tmp/lcc-smoke.sqlite*
npx tsx src/cli.ts index --root test/fixture --db /tmp/lcc-smoke.sqlite
npx tsx src/cli.ts slice --root test/fixture --db /tmp/lcc-smoke.sqlite --query login --policy impact --max-tokens 4000
```

