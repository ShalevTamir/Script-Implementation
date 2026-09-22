# Script-Implementation

A single-file, zero-dependency sanitizer, built as a side-by-side proof next
to the existing `Implementation/` engines (Roslyn for .NET, ts-morph for
Node). It replaces AST-based symbol rename with plain substring substitution
over raw file text — on the premise that this org's real and mock identifier
values are distinctive, proprietary strings, so semantic precision buys
negligible safety over text substitution. See
`../Plan/sanitization-pipeline-plan.md` and `../Implementation/HANDOFF.md`
for the original engines' design this is an alternative to.

Nothing under `../Implementation/` is touched by this folder. It's its own
git repository so the two approaches can be compared independently.

## Requirements

- Node **22.17.x** only (`.nvmrc` provided — `nvm use`). No `npm install`
  needed: `sanitize.js` has zero runtime dependencies.

## Usage

No per-project config, no `cd`-ing into anything — every project needs is
just its source files. Each command takes exactly two required positional
args, input then output:

```bash
node sanitize.js export <inputPath> <outputPath>
node sanitize.js import <inputPath> <outputPath>
```

e.g.

```bash
node sanitize.js export pilots/MockDotnetLibrary /tmp/scratch-export
node sanitize.js import /path/to/public-checkout pilots/MockDotnetLibrary
```

For import, `<outputPath>` is normally the internal project itself (an
in-place import, reconstructing real values back into your working copy).
`<inputPath>` is only ever read, never written to, for both commands.

### Mapping table

One shared `MappingTable/mapping.json`, defaults to the copy next to
`sanitize.js` (override with the `SANITIZER_MAPPING_TABLE` env var):

```json
{
  "entries": [{ "real": "...", "mock": "..." }],
  "exclusions": ["MockDotnetLibrary/src/internal-only", "MockDotnetLibrary/src/internal-only.cs"]
}
```

### Exclusions (from the mapping table, not per-project config)

Each `exclusions` entry is `<projectBasename>/<pathRelativeToProjectRoot>` -
scoped to one project by its folder name, since the table is shared across
all of them. On export, an entry only applies when it starts with
`<inputPath>`'s own basename + `/`; the remainder is the exact path (not a
bare name) stripped from the project root — so `internal-only.js` sitting in
some *other* project, not listed under its name, is left alone. No
`exclusions.json`, no per-repo setup.

Nothing special is needed to "restore" them on import: since they were
never part of the exported/public tree, import copies `<inputPath>` onto
`<outputPath>` as an *overlay* (only adds/overwrites files present in
`<inputPath>`, never deletes anything already at `<outputPath>` that isn't
there) — so pre-existing excluded files at the destination are simply never
touched.

## What the script does

Substitution is plain substring replace (`text.replaceAll(from, to)`) — if a
mapping entry's value appears anywhere in the text, it's replaced, no word
boundaries. Entries are applied longest-value-first so a longer match (e.g.
`TelemetryVaultLib`) isn't partially clobbered by a shorter one (`Telemetry`)
being replaced first.

**Export** (wipes only `<outputPath>/<sanitizedProjectName>` first so it
exactly mirrors `<inputPath>`, then only touches that subfolder from there
on; `<inputPath>` is read-only throughout):
1. Copy `<inputPath>` into `<outputPath>/<sanitizedProjectName>` (skipping
   `.git`, `node_modules`, `bin`, `obj`, `dist`) — `<outputPath>` is a
   container, so multiple projects can be exported into the same one without
   clobbering each other.
2. Strip excluded names.
3. Rename files/directories whose name contains a mapping entry, deepest
   path first.
4. Substitute matching text in every non-binary file (binary detected by
   sniffing for a NUL byte, not a fixed extension list) — one pass covers
   identifiers, comments, string literals, JSON keys/values, XML attributes,
   markdown, anything, since it's all just text.
5. Re-scan the output for any real value that's still present and fail
   loudly if so — nothing should be pushed if this gate fails.

**Import** (additive only, never deletes pre-existing content at
`<outputPath>`):
1. Copy `<inputPath>` onto `<outputPath>` as an overlay.
2. Rename files/directories (mock → real), deepest path first.
3. Substitute matching text (mock → real) in every non-binary file.

## Pilots

Four small fixture repos under `pilots/`, covering every cross-stack
reference shape the real pipeline needs to handle, sharing one
`MappingTable/mapping.json`:

| Repo | Stack | Role |
|---|---|---|
| `MockDotnetLibrary` | .NET | class library |
| `MockDotnetApi` | .NET Core | API, `PackageReference`s `MockDotnetLibrary` |
| `MockNodeLibrary` | Node | plain library (`mock-node-library`) |
| `MockNestApi` | Node (Nest-style) | API, depends on `mock-node-library` via a `file:` reference |

Each contains a `Falcon`/`FalconLabel`/`Falconry` fixture demonstrating plain
substring matching: all three get sanitized (`Falconry` → `Heronry` too, since
there's no word-boundary check). Exporting each repo independently still
produces mutually consistent renames across the API↔library pairs (e.g. `MockDotnetApi`'s `PackageReference` and `using`
both become `OpenDotnetLibrary`; `MockNestApi`'s `package.json` dependency
key/path and `import` both become `open-node-library`), because both sides
read the same shared mapping table.

`MockDotnetLibrary` additionally has `src/internal-only/live-secrets.txt`
and `src/internal-only.cs`, exercising the mapping table's `exclusions` list
— both must never appear in export output.
