# Development toolkit for Hyperware

# Usage: kit <COMMAND>

Commands:
  boot-fake-node       Boot a fake node for development [aliases: f]
  boot-real-node       Boot a real node [aliases: e]
  build                Build a Hyperware package [aliases: b]
  build-start-package  Build and start a Hyperware package [aliases: bs]
  chain                Start a local chain for development [aliases: c]
  connect              Connect (or disconnect) a ssh tunnel to a remote server
  dev-ui               Start the web UI development server with hot reloading (same as `cd ui && npm i && npm run dev`) [aliases: d]
  inject-message       Inject a message to a running node [aliases: i]
  new                  Create a Hyperware template package [aliases: n]
  publish              Publish or update a package [aliases: p]
  remove-package       Remove a running package from a node [aliases: r]
  reset-cache          Reset kit cache (Hyperdrive binaries, logs, etc.)
  run-tests            Run Hyperware tests [aliases: t]
  setup                Fetch & setup kit dependencies
  start-package        Start a built Hyprware package [aliases: s]
  update               Fetch the most recent version of kit
  view-api             Fetch the list of APIs or a specific API [aliases: v]
  help                 Print this message or the help of the given subcommand(s)

Options:
  -v, --version  Print version
  -h, --help     Print help



# `kit inject-message`

short: `kit i`

`kit inject-message` injects the given message to the node running at given port/URL, e.g.,

```bash
kit inject-message foo:foo:hpn-testing-beta.os '{"Send": {"target": "fake2.os", "message": "hello world"}}'
```

## Discussion

`kit inject-message` injects the given message into the given node.
It is useful for:
1. Testing processes from the outside world during development
2. Injecting data into the node
3. Combining the above with `bash` or other scripting.

You can script in the outside world, dump the result to a file, and inject it with `inject-message`.

By default, `inject-message` expects a Response from the target process.
To instead "fire and forget" a message and exit immediately, use the [`--non-block`](#--non-block) flag.

## Arguments

```
$ kit inject-message --help
Inject a message to a running node

Usage: kit inject-message [OPTIONS] <PROCESS> <BODY_JSON>

Arguments:
  <PROCESS>    PROCESS to send message to
  <BODY_JSON>  Body in JSON format

Options:
  -p, --port <NODE_PORT>  localhost node port; for remote see https://book.hyperware.ai/hosted-nodes.html#using-kit-with-your-hosted-node [default: 8080]
  -n, --node <NODE_NAME>  Node ID (default: our)
  -l, --non-block         If set, don't block on the full node response
  -h, --help              Print help
```

### First positional arg: `PROCESS`

The process to send the injected message to in the form of `<process_name>:<package_name>:<publisher>`.

### Second positional arg: `BODY_JSON`

The message body.

### `--port`

short: `-p`

For nodes running on localhost, the port of the node; defaults to `8080`.
`--port` is overridden by `--url` if both are supplied.

### `--node`

short: `-n`

Node to target (i.e. the node portion of the address).

E.g., the following, sent to the port running `fake.os`, will be forwarded from `fake.os`'s HTTP server to `fake2@foo:foo:hpn-testing-beta.os`:

``` bash
kit inject-message foo:foo:hpn-testing-beta.os '{"Send": {"target": "fake.os", "message": "wow, it works!"}}' --node fake2.os
```


### `--non-block`

short: `-l`

Don't block waiting for a Response from target process.
Instead, inject the message and immediately return.
