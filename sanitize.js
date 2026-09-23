#!/usr/bin/env node
'use strict';

/**
 * Single-file, zero-dependency sanitizer: plain substring substitution over
 * file text, path renaming, name-based exclusion strip/restore, and a
 * residual leak-check gate. Language-agnostic by design - it never parses
 * source as an AST, only as text, so it works the same for .cs, .ts, .json,
 * .xml/.csproj, .html, or anything else.
 *
 * Usage:
 *   node sanitize.js export <inputPath> <outputPath>
 *   node sanitize.js import <inputPath> <outputPath>
 *
 * No per-project config needed - both the mapping entries and the excluded
 * names live in one shared mapping table (MappingTable/mapping.json,
 * override with SANITIZER_MAPPING_TABLE).
 */

const fs = require('fs');
const path = require('path');

// Build artifacts/intermediates never belong in exported source - skipped
// during copy so the exported tree only ever contains source. This does NOT
// stop them being checked for leaked real values: `verify <path>` runs the
// same residual check directly against wherever bin/obj/dist actually live
// (e.g. after rebuilding from the exported source), independent of export.
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', 'obj', 'bin', 'dist']);

const DEFAULT_MAPPING_TABLE_PATH =
  process.env.SANITIZER_MAPPING_TABLE || path.join(__dirname, 'MappingTable', 'mapping.json');

// Windows transient-lock tolerance: antivirus/indexer can hold a brief
// handle on a file that's about to move/delete, failing with EBUSY/EPERM/
// ENOTEMPTY even though the file isn't really locked (deleting it by hand a
// moment later works fine). Retry with backoff instead of failing outright.
const RETRYABLE_FS_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const FS_RETRY = { maxRetries: 5, retryDelay: 100 };

function retryOnTransientLock(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!RETRYABLE_FS_ERROR_CODES.has(err.code) || attempt >= FS_RETRY.maxRetries) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FS_RETRY.retryDelay * (attempt + 1));
    }
  }
}

const BINARY_SNIFF_BYTES = 8192;

// ---------------------------------------------------------------------------
// Mapping table
// ---------------------------------------------------------------------------

function loadMappingTable(mappingTablePath) {
  const {
    entries = [],
    exclusions = [],
    linesToRemove = [],
  } = JSON.parse(fs.readFileSync(mappingTablePath, 'utf8'));

  const seenReal = new Set();
  const seenMock = new Set();
  for (const { real, mock } of entries) {
    if (seenReal.has(real) || seenMock.has(mock)) {
      throw new Error(`mapping table collision on "${real}" -> "${mock}" (${mappingTablePath})`);
    }
    seenReal.add(real);
    seenMock.add(mock);
  }

  const sortLongestFirst = (pairs) => [...pairs].sort((a, b) => b.from.length - a.from.length);

  return {
    forExport: () => sortLongestFirst(entries.map((e) => ({ from: e.real, to: e.mock }))),
    forImport: () => sortLongestFirst(entries.map((e) => ({ from: e.mock, to: e.real }))),
    realValues: () => entries.map((e) => e.real),
    // exclusions entries are "<projectBasename>/<pathRelativeToProjectRoot>" -
    // the shared table can list exclusions for many projects at once, so
    // each one is scoped by which project's own folder name it starts with.
    excludedPathsFor: (projectBasename) => {
      const prefix = `${projectBasename}/`;
      return exclusions.filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
    },
    lineRemovalPatterns: () => linesToRemove.map(globToLineRegExp),
  };
}

// ---------------------------------------------------------------------------
// Glob-style line matching for "linesToRemove" - "*" matches any run of
// characters, everything else is literal. Matched against the whole line.
// ---------------------------------------------------------------------------

function escapeRegExpChars(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToLineRegExp(pattern) {
  return new RegExp(`^${pattern.split('*').map(escapeRegExpChars).join('.*')}$`);
}

// ---------------------------------------------------------------------------
// Plain substring substitution - if the text contains it, replace it.
// ---------------------------------------------------------------------------

function applySubstitution(text, pairs) {
  let result = text;
  for (const { from, to } of pairs) {
    result = result.replaceAll(from, to);
  }
  return result;
}

function containsMatch(text, needle) {
  return text.includes(needle);
}

// ---------------------------------------------------------------------------
// Binary detection - sniff for a NUL byte rather than trusting a fixed
// extension allow-list, so unfamiliar text file types still get sanitized
// (and checked) instead of silently passing through untouched.
// ---------------------------------------------------------------------------

function isBinaryFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Filesystem walking
// ---------------------------------------------------------------------------

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (SKIP_DIR_NAMES.has(path.basename(src))) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    retryOnTransientLock(() => fs.copyFileSync(src, dest));
  }
}

function walkFiles(root, callback) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    const full = path.join(root, entry);
    if (fs.statSync(full).isDirectory()) {
      walkFiles(full, callback);
    } else {
      callback(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Exclusion (paths from the mapping table's "exclusions" list, relative to
// the project root - see excludedPathsFor above)
// ---------------------------------------------------------------------------

function stripExcludedEntries(projectRoot, relativePaths) {
  for (const relativePath of relativePaths) {
    fs.rmSync(path.join(projectRoot, relativePath), { recursive: true, force: true, ...FS_RETRY });
  }
}

// ---------------------------------------------------------------------------
// .sln reference cleanup - an excluded .csproj (or a directory holding one)
// leaves its solution file pointing at a path that no longer exists: a
// `Project(...) ... EndProject` block plus matching GUID-keyed lines in the
// Global sections. Basenames are collected before stripExcludedEntries
// deletes the files, then matched against each Project block's quoted path
// (basename only, since the .sln path separator may not match the host OS).
// ---------------------------------------------------------------------------

function collectExcludedCsprojBasenames(projectRoot, relativePaths) {
  const basenames = new Set();
  for (const relativePath of relativePaths) {
    const fullPath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    if (fs.statSync(fullPath).isDirectory()) {
      walkFiles(fullPath, (filePath) => {
        if (filePath.endsWith('.csproj')) basenames.add(path.basename(filePath));
      });
    } else if (fullPath.endsWith('.csproj')) {
      basenames.add(path.basename(fullPath));
    }
  }
  return basenames;
}

const SLN_PROJECT_BLOCK_PATTERN =
  /^Project\("\{[0-9A-Fa-f-]+\}"\)\s*=\s*"[^"]*",\s*"([^"]*)",\s*"(\{[0-9A-Fa-f-]+\})"\r?\n[\s\S]*?^EndProject\r?\n/gm;

function stripSolutionProjectReferences(slnText, csprojBasenames) {
  const removedGuids = [];
  const withoutBlocks = slnText.replace(SLN_PROJECT_BLOCK_PATTERN, (block, projectPath, guid) => {
    const basename = projectPath.split(/[\\/]/).pop();
    if (!csprojBasenames.has(basename)) return block;
    removedGuids.push(guid);
    return '';
  });
  if (removedGuids.length === 0) return slnText;

  // Global-section lines (ProjectConfigurationPlatforms, NestedProjects, ...)
  // reference a project by its GUID, one per line - no block structure to
  // parse, just drop any line mentioning a GUID whose Project block was removed.
  const keptLines = withoutBlocks.split('\n').filter((line) => !removedGuids.some((guid) => line.includes(guid)));
  return keptLines.join('\n');
}

function cleanSolutionReferences(projectRoot, csprojBasenames) {
  if (csprojBasenames.size === 0) return;
  walkFiles(projectRoot, (filePath) => {
    if (!filePath.endsWith('.sln')) return;
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = stripSolutionProjectReferences(original, csprojBasenames);
    if (updated !== original) fs.writeFileSync(filePath, updated, 'utf8');
  });
}

// ---------------------------------------------------------------------------
// Path renaming - deepest path first, so renaming a directory never
// invalidates a deeper path already queued up in the same pass.
// ---------------------------------------------------------------------------

function collectPathsDeepestFirst(root) {
  const all = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      all.push(full);
      if (fs.statSync(full).isDirectory()) walk(full);
    }
  };
  walk(root);
  return all.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

function moveWithMerge(source, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).isDirectory() && fs.statSync(source).isDirectory()) {
    for (const entry of fs.readdirSync(source)) {
      moveWithMerge(path.join(source, entry), path.join(dest, entry));
    }
    retryOnTransientLock(() => fs.rmdirSync(source));
  } else {
    retryOnTransientLock(() => fs.renameSync(source, dest));
  }
}

function renamePaths(root, pairs) {
  for (const originalPath of collectPathsDeepestFirst(root)) {
    if (!fs.existsSync(originalPath)) continue; // already relocated by an earlier (deeper) rename

    const dir = path.dirname(originalPath);
    const name = path.basename(originalPath);
    const newName = applySubstitution(name, pairs);
    if (newName === name) continue;

    moveWithMerge(originalPath, path.join(dir, newName));
  }
}

// ---------------------------------------------------------------------------
// Content substitution
// ---------------------------------------------------------------------------

function substituteFileContents(root, pairs) {
  walkFiles(root, (filePath) => {
    if (isBinaryFile(filePath)) return;
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = applySubstitution(original, pairs);
    if (updated !== original) fs.writeFileSync(filePath, updated, 'utf8');
  });
}

// ---------------------------------------------------------------------------
// Line removal (export only - deleting a line loses information there's
// nothing to reverse-map on import, unlike substitution)
// ---------------------------------------------------------------------------

function removeMatchingLines(root, patterns) {
  if (patterns.length === 0) return;
  walkFiles(root, (filePath) => {
    if (isBinaryFile(filePath)) return;
    const original = fs.readFileSync(filePath, 'utf8');
    const lines = original.split('\n');
    const kept = lines.filter((line) => !patterns.some((re) => re.test(line.replace(/\r$/, ''))));
    if (kept.length !== lines.length) fs.writeFileSync(filePath, kept.join('\n'), 'utf8');
  });
}

// ---------------------------------------------------------------------------
// Residual check gate (export only)
//
// Binary files (compiled DLLs, bundled/minified output that still sniffs as
// binary) aren't decoded as text - instead their raw bytes are searched for
// each real value in both UTF-8 and UTF-16LE, since compiled .NET assemblies
// store type/method/string-literal names UTF-16LE-encoded in their metadata.
// This only checks; it never rewrites binaries (unsafe - metadata heap
// offsets would corrupt), so a hit here means "rebuild from sanitized
// source," not something the script can fix in place.
// ---------------------------------------------------------------------------

function bufferContainsValue(buffer, value) {
  return buffer.includes(value, 0, 'utf8') || buffer.includes(value, 0, 'utf16le');
}

function residualCheck(root, realValues) {
  const findings = [];
  walkFiles(root, (filePath) => {
    if (isBinaryFile(filePath)) {
      const buffer = fs.readFileSync(filePath);
      for (const real of realValues) {
        if (bufferContainsValue(buffer, real)) findings.push({ file: filePath, value: real });
      }
      return;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    for (const real of realValues) {
      if (containsMatch(text, real)) findings.push({ file: filePath, value: real });
    }
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function assertDistinctPaths(inputRoot, outputRoot) {
  if (path.resolve(inputRoot) === path.resolve(outputRoot)) {
    throw new Error(`inputPath and outputPath must be different (both resolved to ${inputRoot})`);
  }
}

// Prints any residual-check findings and returns whether the check passed.
function reportResidualFindings(failureHeader, findings) {
  if (findings.length === 0) return true;
  console.error(failureHeader);
  for (const { file, value } of findings) {
    console.error(`[GATE FAIL] residual real value '${value}' found in ${file}`);
  }
  return false;
}

function runExport(inputRoot, outputRoot) {
  assertDistinctPaths(inputRoot, outputRoot);
  const mapping = loadMappingTable(DEFAULT_MAPPING_TABLE_PATH);
  const exportPairs = mapping.forExport();

  // outputRoot is a container - the project lands in a subfolder named
  // after its own sanitized basename (e.g. exports/OpenDotnetLibrary), so
  // multiple projects can be exported into the same output directory.
  // Fresh copy: only that subfolder is wiped first, not the whole
  // container, so it exactly mirrors inputRoot with nothing stale from a
  // prior run. inputRoot is only ever read from here on.
  const projectRoot = path.join(outputRoot, applySubstitution(path.basename(inputRoot), exportPairs));
  fs.rmSync(projectRoot, { recursive: true, force: true, ...FS_RETRY });
  copyRecursive(inputRoot, projectRoot);

  const excludedRelativePaths = mapping.excludedPathsFor(path.basename(inputRoot));
  const excludedCsprojBasenames = collectExcludedCsprojBasenames(projectRoot, excludedRelativePaths);
  stripExcludedEntries(projectRoot, excludedRelativePaths);
  cleanSolutionReferences(projectRoot, excludedCsprojBasenames);

  removeMatchingLines(projectRoot, mapping.lineRemovalPatterns());
  renamePaths(projectRoot, exportPairs);
  substituteFileContents(projectRoot, exportPairs);

  const findings = residualCheck(projectRoot, mapping.realValues());
  const passed = reportResidualFindings(
    'EXPORT FAILED - residual sensitive values found. Nothing should be pushed.',
    findings
  );
  if (!passed) {
    process.exitCode = 1;
    return;
  }

  console.log(`EXPORT PASSED. Sanitized tree at: ${projectRoot}`);
}

// Runs only the residual check against an already-existing path - no copy,
// no substitution, no other passes. Useful for re-checking an export output
// (or any other tree) later without redoing the whole export.
function runVerify(targetPath) {
  const mapping = loadMappingTable(DEFAULT_MAPPING_TABLE_PATH);
  const findings = residualCheck(targetPath, mapping.realValues());
  const passed = reportResidualFindings('VERIFY FAILED - residual sensitive values found.', findings);
  if (!passed) {
    process.exitCode = 1;
    return;
  }

  console.log(`VERIFY PASSED. No residual real values found under: ${targetPath}`);
}

function runImport(inputRoot, outputRoot) {
  assertDistinctPaths(inputRoot, outputRoot);
  const mapping = loadMappingTable(DEFAULT_MAPPING_TABLE_PATH);

  // Overlay only: outputRoot is normally the internal project itself, so
  // copy inputRoot's files in without deleting anything already there -
  // that's what keeps excluded entries (e.g. internal-only/) intact with no
  // snapshot-and-restore needed.
  copyRecursive(inputRoot, outputRoot);
  renamePaths(outputRoot, mapping.forImport());
  substituteFileContents(outputRoot, mapping.forImport());

  console.log(`IMPORT COMPLETE. Reconstructed tree at: ${outputRoot}`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const USAGE =
  'Usage: sanitize export <inputPath> <outputPath> | sanitize import <inputPath> <outputPath> | sanitize verify <path>';

function main(argv) {
  const [command, inputArg, outputArg] = argv;

  if (command === 'verify') {
    if (!inputArg) {
      console.log(USAGE);
      process.exitCode = 1;
      return;
    }
    runVerify(path.resolve(inputArg));
    return;
  }

  if ((command !== 'export' && command !== 'import') || !inputArg || !outputArg) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const inputRoot = path.resolve(inputArg);
  const outputRoot = path.resolve(outputArg);

  if (command === 'export') {
    runExport(inputRoot, outputRoot);
  } else {
    runImport(inputRoot, outputRoot);
  }
}

main(process.argv.slice(2));
