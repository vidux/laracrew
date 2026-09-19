---
name: prepare-for-publish
description: Pre-publish checklist for releasing laracrew to npm — version decision, stale-claim sweep, CHANGELOG entry, and the packed-tarball smoke test that catches what `npm test` cannot. Use before any release, version bump, or `npm publish`, and whenever asked to "prepare a release" or "get this ready to ship".
---

# Preparing a laracrew release

## Why this exists

In the 0.2.0 prep, all 243 tests passed, `typecheck` was clean, the build succeeded — and the
shipped binary printed `laracrew --version` → **`0.1.0`**. `VERSION` was a hardcoded constant in
`src/cli/program.ts` that nobody bumped, so the already-published `0.1.1` and `0.1.2` both
identified themselves as `0.1.0` on users' machines.

Nothing in the test suite could have caught it. It surfaced only from packing the tarball,
installing it into an empty directory, and running the binary.

**The rule this gives you: a green test suite is not a release check.** Tests exercise the source
tree. Publishing ships a tarball: the `files` allowlist, the `bin` shim, the shebang, the bundled
`dist/index.js`, and the identity the binary reports. Verify the artifact, not the repo.

## Order of operations

Do these in order — the sweep is cheap and the smoke test is slow, so don't smoke-test a tree
you're about to edit.

### 1. Decide the version

While below `1.0.0`: a new config key or command is **minor**; a bug fix with no new surface is
**patch**. Reserve major for when `1.0.0` arrives. A behaviour change that can only surface an
error in a config that never worked (0.2.0's `stop.artisan` without a `project`) is not breaking
— but it goes under **Changed** in the changelog with a migration note, per `CHANGELOG.md`'s own
preamble.

Edit `package.json` by hand. Do **not** run `npm version` — it creates a commit and a tag, and
committing is the user's call.

### 2. Sweep for stale claims

These drift every single release. Grep before trusting any of them:

```bash
grep -rn "Not published\|v0\.[0-9]\.[0-9]\|[0-9]\{3\} tests\|OWNER" README.md CHANGELOG.md package.json src/
```

| Where | What goes stale |
|---|---|
| `README.md` § Status | `**v0.1.0 — ...**` — the version line, and the "Working now" list |
| `README.md` § Development | `npm test  # vitest, NNN tests` — the count changes on every new test |
| `README.md` § Install | Claims about npm availability ("not published yet") |
| `CHANGELOG.md` footer | Link refs — the template ships `github.com/OWNER/...` placeholders |
| `CHANGELOG.md` | Entries missing for versions that were tagged and published |
| `package.json` `description` | Must not contradict `program.ts`'s `.description(...)` |
| `package.json` `files` | Every entry must exist — a listed-but-missing file is silently dropped |

Get the real test count from the suite, not from memory: `npm test 2>&1 | tail -5`.

### 3. Write the CHANGELOG entry

`CHANGELOG.md` is in `package.json#files`, so it ships inside the tarball — it is user-facing
documentation, not a commit log. Group under **Added / Changed / Fixed / Notes**. Lead each entry
with what the user observes, not the code that changed. Fixed entries state the symptom first:
"`laracrew --version` reported `0.1.0` on every release", then the cause.

Check `git tag -l` against the changelog headings — a tagged, published version with no entry is
a hole worth filling while you're in there.

### 4. Run the real gate

```bash
npm run prepublishOnly    # typecheck && test && build — exactly what `npm publish` runs
```

Run it explicitly. Don't infer it passes because the three commands passed separately earlier.

### 5. Smoke-test the packed tarball

This is the step that earns its keep. Either run the script beside this file:

```bash
bash .claude/skills/prepare-for-publish/smoke-test.sh
```

or do it by hand: `npm pack`, `npm install <tarball>` into an empty directory, then exercise the
installed binary — never `node dist/index.js`, which skips the bin shim and the `files` allowlist.

What to actually check:

- `laracrew --version` **equals** `package.json`'s version. This is the one that has bitten.
- `npm pack --dry-run` contents: `dist/`, `examples/`, `README.md`, `LICENSE`, `CHANGELOG.md`.
  Nothing from `src/`, `test/` or `.claude/`.
- `init --examples` → `ls` → `doctor example` exits 0 → `up example` boots → `logs --list` reads
  back. That path touches config writing, resolution, spawning, the log sink and the reader.
- No stray child processes survive the run. laracrew is a process supervisor; a leak here is a
  release-blocking bug, not test noise.

### 6. Clean up, then hand off

`npm pack` drops a `.tgz` in the repo root. It is gitignored now, but check it did not get staged
(`git status --short` showing `A  laracrew-*.tgz` means `git rm --cached` it).

Then stop. Print the commands and let the user run them:

```bash
git add -A && git commit -m "0.2.0"
git tag v0.2.0
npm publish
```

Publishing is irreversible and outward-facing — never run `npm publish`, `git push`, or
`npm version` on your own initiative.

## Smoke-testing on Windows (this is the dev machine)

Bounding a long-running CLI run is the awkward part, because laracrew's whole job is to not exit:

- **`timeout -s INT 5 node dist/index.js up …` does not work.** Git Bash cannot deliver a real
  Ctrl-C to a native Windows process; the command runs forever and gets backgrounded. What
  actually stops it is closing the pipe — `… up example --plain | head -6` — which trips the
  CLI's own pipe guards and runs a clean shutdown.
- To kill a runaway supervisor and its children:
  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*up example*' } | Stop-Process -Force
  ```
- **Git Bash `$PWD` is `/d/npm_dev/...`, which Windows `node` resolves to `C:\d\npm_dev\...`**
  and then fails with `MODULE_NOT_FOUND`. Use `cygpath -m` or a literal `D:/...` path for
  anything handed to node, or written into a YAML fixture.
- `grep -v` with no matches exits 1 and silently breaks an `&&` chain. Use `;` and check
  `${PIPESTATUS[0]}` when you want the real exit code of the piped command.

## Editing source files with regex escapes

Unrelated to publishing but learned the hard way in the same session: feeding a patch script to
Python via a Bash heredoc halves backslashes, so `\\b` arrived as `\b` and Python wrote a literal
backspace (`0x08`) into `doctor.ts`. `grep` rendered it invisibly.

Use the Edit tool for any change containing regex escapes, Windows paths, or `\b`/`\d`/`\s`. If a
script did the edit, verify with `sed -n '27p' file | cat -A` before moving on — control
characters do not show up in ordinary output.
