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

Delete/move/copy operations retry with backoff (up to 5 attempts) on
`EBUSY`/`EPERM`/`ENOTEMPTY`/`EMFILE`/`ENFILE` — transient Windows file-lock
errors from antivirus/indexers briefly holding a handle on a file that isn't
actually in use. Any other error still fails immediately.

## Usage

No per-project config, no `cd`-ing into anything — every project needs is
just its source files.

```bash
node sanitize.js export <inputPath> <outputPath>
node sanitize.js import <inputPath> <outputPath>
node sanitize.js verify <path>
```

e.g.

```bash
node sanitize.js export pilots/MockDotnetLibrary /tmp/scratch-export
node sanitize.js import /path/to/public-checkout pilots/MockDotnetLibrary
node sanitize.js verify /tmp/scratch-export/OpenDotnetLibrary
```

For import, `<outputPath>` is normally the internal project itself (an
in-place import, reconstructing real values back into your working copy).
`<inputPath>` is only ever read, never written to, for export/import.

`verify` runs only the residual check (step 5 below) against an
already-existing path — no copy, no substitution, no other pass. Useful for
re-checking an export's output later (e.g. after a separate CI build step
regenerates `bin`/`dist`) without redoing the whole export.

### Mapping table

One shared `MappingTable/mapping.json`, defaults to the copy next to
`sanitize.js` (override with the `SANITIZER_MAPPING_TABLE` env var):

```json
{
  "entries": [{ "real": "...", "mock": "..." }],
  "exclusions": ["MockDotnetLibrary/src/internal-only", "MockDotnetLibrary/src/internal-only.cs"],
  "protectedTokens": ["nativeElement", "provideNativeDateAdapter"]
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

### Protected tokens (global, not project-scoped)

`protectedTokens` is a flat list of exact literal strings that must never be
touched by rename, content substitution, or the residual check, anywhere
they appear, across every project - unlike `exclusions`, this isn't scoped
per project, since these are typically framework/API keywords rather than
project-specific paths.

This exists because plain substring matching has no concept of "this real
value is part of an unrelated, longer identifier": if a real value happens
to be a substring of some common framework member name, substitution would
corrupt code that was never meant to change. The canonical example is
Angular: a real value like `nativ` sits right at the start of both
`ElementRef.nativeElement` and Angular Material's
`provideNativeDateAdapter`, so without protection, sanitizing `nativ` would
mangle every reference to either into a broken identifier.

A protected token is hidden (swapped for an internal marker) before any
matching runs, then restored afterward - so `nativeElement` itself is never
touched, while `nativ` elsewhere (e.g. inside `nativApp`, as its own
identifier, in a comment) still gets substituted completely normally. It's
not a per-value setting - list the exact framework identifier, not the
colliding real value, so everything else that value legitimately matches
keeps working.

## What the script does

Substitution is plain substring replace (`text.replaceAll(from, to)`) — if a
mapping entry's value appears anywhere in the text, it's replaced, no word
boundaries. Entries are applied longest-value-first so a longer match (e.g.
`TelemetryVaultLib`) isn't partially clobbered by a shorter one (`Telemetry`)
being replaced first.

**Exception: integers and IPv4 addresses.** A mapping value that's just
digits (e.g. a port, `5432`) or shaped like an IPv4 address (e.g.
`10.20.30.40`) is matched at a real word boundary instead of as a plain
substring, automatically — no config needed, it's inferred from the value's
own shape. Distinctive proprietary names essentially never collide with
unrelated text, but short numeric/IP-shaped values constantly do: `5432` is
also a substring of `15432` and `2025432`, and `10.20.30.40` is a substring
of `10.20.30.400`. Plain substring replace would corrupt those unrelated
values; boundary matching only touches an exact standalone occurrence. This
applies everywhere the value is matched - content substitution, path/name
renaming, and the residual check gate.

**Export** (wipes only `<outputPath>/<sanitizedProjectName>` first so it
exactly mirrors `<inputPath>`, then only touches that subfolder from there
on; `<inputPath>` is read-only throughout):
1. Copy `<inputPath>` into `<outputPath>/<sanitizedProjectName>` (skipping
   `.git`, `node_modules`, `obj`, `bin`, `dist`, `.vs`, `.angular` — build
   artifacts/intermediates and local IDE/CLI cache never belong in exported
   source) — `<outputPath>` is a container, so multiple projects can be
   exported into the same one without clobbering each other.
2. Strip excluded paths. If an excluded path is (or contains) a `.csproj`,
   any `.sln` file in the tree also has that project's `Project(...) ...
   EndProject` block removed, along with every `GlobalSection` line keyed by
   that project's GUID - otherwise the solution would still reference a
   project file that no longer exists.
3. Rename files/directories whose name contains a mapping entry, deepest
   path first.
4. Substitute matching text in every non-binary file — one pass covers
   identifiers, comments, string literals, JSON keys/values, XML attributes,
   markdown, anything, since it's all just text. Binary files (DLLs,
   already-bundled output) are left untouched here - rewriting bytes inside
   a compiled binary isn't safe. Binary is detected by sniffing for a NUL
   byte in the first 8KB, *except* known generic asset extensions (images,
   fonts, archives, media - the same list the residual check treats as
   high-entropy noise), which are always treated as binary regardless of
   that sniff - a small font/image can have no NUL byte at all within the
   sniff window, and misreading it as text here would corrupt it on write-back.

   `package.json` and `package-lock.json` are exempt from this step (their
   content is left exactly as copied) - a lockfile's `resolved` URLs and
   `integrity` hashes are computed against the *real* package name/tarball,
   so text-substituting a dependency name in place doesn't re-resolve or
   re-hash anything; it just produces a lockfile that looks renamed but is
   actually broken. They ship as-is, real values and all (e.g. a
   `package.json` depending on another exported project keeps its real
   dependency name) - the residual check exempts these two filenames from
   gate failures for exactly this reason (see step 5).
5. Re-scan the output for any real value that's still present and fail
   loudly if so — nothing should be pushed if this gate fails. Checks both a
   file/directory's own name and its contents - renaming already happens in
   step 3, but the gate re-checks names independently rather than trusting
   that pass (`verify` in particular may run standalone against a tree that
   was never renamed). Binary files are checked too, by searching their raw
   bytes for each real value UTF-8- and UTF-16LE-encoded (compiled .NET
   assemblies store
   type/method/string names UTF-16LE in their metadata), so a leak baked
   into a DLL still fails the gate even though it wasn't (and can't safely
   be) rewritten in step 4 - the fix is rebuilding from sanitized source,
   not patching the binary. Since `bin`/`dist` are skipped during copy (step
   1), this only sees whatever compiled output happens to already be at
   `<inputPath>` — rebuild from the sanitized source and run `verify
   <path-to-bin-or-dist>` separately to check the actual shipped artifacts.

   Matching is plain substring everywhere **except** inside a path with a
   skipped-dir name (`bin`, `obj`, `dist`, `.vs`, `.angular`, `node_modules`,
   `.git`) -
   those are never part of what export actually copies, so encountering one
   during `verify` means auto-generated or third-party content full of
   generic runtime/BCL text, where a short real value can coincidentally sit
   inside some unrelated longer word without anything having leaked. There,
   a hit only counts at a real word boundary (not preceded/followed by
   `[A-Za-z0-9_]`). Everywhere else - your own source - stays plain
   substring, since that's where the distinctive-naming assumption actually
   holds.

   Any binary file with a generic asset extension (`.png`, `.jpg`, `.gif`,
   `.ico`, `.webp`, `.woff`/`.woff2`/`.ttf`/`.otf`/`.eot`, `.pdf`,
   `.zip`/`.gz`/`.7z`, `.mp3`/`.mp4`/`.wav`/`.mov`/`.avi`/`.ogg`/`.flac`) is
   excluded from **content** scanning entirely, regardless of which
   directory it's in - even a word-boundary match is unreliable there, since
   compressed image/font/media bytes are high-entropy noise where most
   random bytes already look like a boundary, so a short real value has a
   real chance of turning up purely by chance. These extensions are always
   treated as binary here too (never text), independent of the NUL-byte
   sniff, so a small asset with no NUL byte in it can't be misread as text
   and corrupted on write-back during substitution (step 4). File/directory
   *names* are still checked normally either way - that's ordinary
   human-authored text, not noise.

   `package.json` and `package-lock.json` are excluded from content scanning
   entirely too, for the same reason step 4 never rewrites them: their
   content isn't touched, so a real value there (e.g. a dependency on
   another exported project) isn't a leak the tool introduced, and it
   shouldn't block export. File/directory names for these two are still
   checked normally.

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
produces mutually consistent renames across the API↔library pairs (e.g.
`MockDotnetApi`'s `PackageReference` and `using` both become
`OpenDotnetLibrary`; `MockNestApi`'s `import` becomes `open-node-library`),
because both sides read the same shared mapping table.

`MockDotnetLibrary` additionally has `src/internal-only/live-secrets.txt`
and `src/internal-only.cs`, exercising the mapping table's `exclusions` list
— both must never appear in export output.

`MockDotnetApi` additionally has `MockDotnetApi.sln` referencing both itself
and an excluded `src/InternalTools/InternalTools.csproj`, exercising the
solution-reference cleanup: after export, the `.sln` still parses and
contains only the `OpenDotnetApi` project - no leftover `InternalTools`
`Project` block or orphaned GUID lines.

`MockNestApi`'s `package.json` ships with its real dependency
(`mock-node-library`) intact, exercising the `package.json`/
`package-lock.json` residual-check exemption from step 5: content is never
substituted for these two filenames, and the gate no longer fails on
whatever real values are still in them.

`MockNodeLibrary` additionally has a `dbHost`/`dbHostWithSuffix`/`ports`
fixture exercising the integer/IPv4 boundary-matching exception: `dbHost`
(`10.20.30.40`) and the first `ports` entry (`5432`) get sanitized, while
`dbHostWithSuffix` (`10.20.30.400`) and the other `ports` entries (`15432`,
`25432`) must not be touched even though the mapped value is a substring of
each.
