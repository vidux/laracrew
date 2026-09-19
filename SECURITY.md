# Security

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue. Use GitHub's
**Report a vulnerability** button under the repository's Security tab, or email the maintainer.

Include what you found, how to reproduce it, and what an attacker could do with it. You will get
an acknowledgement within a few days.

## What laracrew does on your machine

Worth knowing when you assess the risk:

- **It runs the commands in your stack files.** A `stack.yaml` is executable configuration, no
  different from a shell script. Do not run a stack file you did not write or read.
- **It reads your projects' `.env` files** to resolve `${project.env:VAR}` tokens and to run
  `doctor` checks. Values are held in memory and are never written to disk, logged, or sent
  anywhere. laracrew makes no network requests of its own; the only sockets it opens are the
  `tcp` and `http` readiness probes your stack declares.
- **It writes only inside `~/.laracrew/`**, plus the global commands `laracrew link` installs.
  It never modifies your Laravel projects.
- **`laracrew link` writes executables onto your PATH.** Generated files carry a
  `laracrew-generated` marker; laracrew refuses to overwrite a file it did not write, and
  refuses to shadow names like `npm` and `git` unless you pass `--force`.

## Supported versions

While below `1.0.0`, only the latest published version receives fixes.
