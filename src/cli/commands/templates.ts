/**
 * Kept as string constants rather than shipped files: no path resolution to get wrong
 * between `tsx src/index.ts` and the bundled `dist/index.js`, and nothing to forget in
 * package.json#files.
 */

export const CONFIG_YAML = `# laracrew global preferences
# theme: auto | dark | light | mono | high-contrast
theme: auto

# Polling interval for queue depth and stream lag, in milliseconds.
metricsIntervalMs: 2000

# The stack \`laracrew up\` boots when you don't name one.
# defaultStack: dual
`;

export const PROJECTS_YAML = `# Your Laravel projects, referenced by key from any stack.
# Paths may use forward slashes on Windows.
projects: {}

# Example — delete the \`{}\` above and uncomment:
#
# projects:
#   api:
#     path: D:/work/api
#     php: php            # or an absolute path to a specific PHP build
#     envFile: .env       # read for QUEUE_CONNECTION, REDIS_*, APP_URL, DB_*
#     color: cyan
#   portal:
#     path: D:/work/portal
#     php: php
#     envFile: .env
#     color: magenta
`;

/** A stack that actually runs on a fresh install, so `laracrew up example` works immediately. */
export const EXAMPLE_STACK_YAML = `# A runnable demo stack — no Laravel project required.
# Try:  laracrew up example
# Then: laracrew up example --only workers
name: example
description: Three fake services that prove laracrew works on this machine

# \`laracrew link example\` installs this as a global command you can run from anywhere.
command: demo

defaults:
  restart: on-failure
  backoff: { initialMs: 500, maxMs: 5000, factor: 2, maxRestarts: 5 }
  stop: { graceMs: 5000 }

services:
  - name: demo:heartbeat
    cmd: ["node", "-e", "let n=0; setInterval(() => console.log('heartbeat ' + (++n)), 1000)"]
    groups: [workers]
    color: cyan

  - name: demo:worker
    cmd: ["node", "-e", "let n=0; setInterval(() => console.log('processed job #' + (++n)), 1700)"]
    groups: [workers]
    needs: [demo:heartbeat]
    color: magenta

  - name: demo:slow-starter
    cmd: ["node", "-e", "setTimeout(() => console.log('listening on 9'), 1200); setInterval(() => {}, 1000)"]
    groups: [http]
    ready: { logMatch: "listening on", timeoutMs: 10000 }
    color: green

profiles:
  quiet:
    except: [http]
`;

export const REAL_STACK_TEMPLATE = `# Two interconnected Laravel projects: queues, Redis stream listeners, schedulers.
# Fill in the project paths in ~/.laracrew/projects.yaml first, then:  laracrew up dual
name: dual
description: API + Portal with queues, streams and schedulers

# Run \`laracrew link dual\` and this whole set boots by typing \`dual\` from anywhere.
command: dual

use: [api, portal]

defaults:
  restart: on-failure
  backoff: { initialMs: 1000, maxMs: 30000, factor: 2, maxRestarts: 10 }
  stop: { graceMs: 10000 }
  logs: { maxLines: 5000, toFile: false }

services:
  - name: redis
    external: true              # laracrew checks it, never starts it
    ready: { tcp: "127.0.0.1:6379" }

  - name: api:serve
    project: api
    cmd: php artisan serve --port=\${port:8000}
    groups: [http]
    needs: [redis]
    ready: { http: "http://127.0.0.1:8000/up", timeoutMs: 20000 }
    url: http://127.0.0.1:8000

  - name: api:queue
    project: api
    cmd: php artisan queue:work redis --queue=high,default --tries=3 --timeout=90
    groups: [workers]
    needs: [redis]
    stop: { artisan: "queue:restart", graceMs: 15000 }
    watch:
      paths: [app, config, routes, database]
      strategy: artisan-queue-restart
      debounceMs: 800
    metrics:
      queues: [high, default]

  - name: api:streams
    project: api
    cmd: php artisan streams:listen orders
    groups: [workers, streams]
    needs: [redis]
    metrics:
      streams:
        - { key: orders, group: api-consumers }

  - name: api:schedule
    project: api
    cmd: php artisan schedule:work
    groups: [workers]
    needs: [redis]

  - name: portal:serve
    project: portal
    cmd: php artisan serve --port=\${port:8001}
    groups: [http]
    needs: [redis, api:serve]   # don't boot until the API answers
    ready: { http: "http://127.0.0.1:8001/up", timeoutMs: 20000 }
    url: http://127.0.0.1:8001

  - name: portal:queue
    project: portal
    cmd: php artisan queue:work redis --queue=default --tries=3
    groups: [workers]
    needs: [redis, api:serve]
    stop: { artisan: "queue:restart" }
    watch: { paths: [app, config], strategy: artisan-queue-restart }
    metrics: { queues: [default] }

  - name: portal:streams
    project: portal
    cmd: php artisan streams:listen inventory
    groups: [workers, streams]
    needs: [redis]
    metrics:
      streams:
        - { key: inventory, group: portal-consumers }

profiles:
  light:
    except: [assets]
  workers-only:
    only: [workers]
`;

export const RESET_TASK_YAML = `# laracrew run reset
name: reset
description: Wipe and reseed both databases in the right order
pauseServices: [workers]     # stopped before the steps, restarted after
steps:
  - { project: api, cmd: php artisan migrate:fresh --seed }
  - { project: portal, cmd: php artisan migrate:fresh --seed }
  - parallel:
      - { project: api, cmd: php artisan cache:clear }
      - { project: portal, cmd: php artisan cache:clear }
`;

export const HOME_README = `# ~/.laracrew

Your laracrew configuration. Safe to keep in git — nothing here is secret unless you put
secrets in it.

    config.yaml        global preferences
    projects.yaml      your Laravel projects, referenced by key
    stacks/<name>/     one folder per stack; stack.yaml is the definition
    tasks/<name>.yaml  one-shot sequences (laracrew run <name>)
    fragments/         shared YAML any stack can reuse
    logs/              per-run log files, when defaults.logs.toFile is on

Start here:

    laracrew init --examples   # add a demo stack and a two-project template
    laracrew ls                # what is defined
    laracrew doctor <stack>    # check a stack before booting it
    laracrew link <stack>      # give a stack its own global command
`;
