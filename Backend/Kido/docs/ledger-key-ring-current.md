# Ledger Key Ring — current behaviour, verified 2026-09-06

Verified against the **real installed binary**, not from the build bible and not from docs prose
alone. Everything below was either printed by `wallet-cli --help` / `ring <cmd> --help` or observed
by running the command.

## Versions

| Package | Version | Notes |
|---|---|---|
| `@ledgerhq/wallet-cli` | **2.1.0** | thin launcher; delegates to a platform binary |
| `@ledgerhq/wallet-cli-darwin-arm64` | 2.1.0 | the actual 127 MB compiled binary |
| `@ledgerhq/device-management-kit` | 1.9.0 | Phase 7 |
| `@ledgerhq/device-signer-kit-ethereum` | 1.18.0 | Phase 7 |
| `@ledgerhq/context-module` | 2.5.0 | Phase 7, Clear Signing context |
| `@ledgerhq/device-transport-kit-node-hid` | 1.0.1 | Phase 7, USB transport |

`2.0.0` introduced the `ring` (Ledger Key Ring / **LKRP**) command group; `2.1.0` added `skill`.

## ⚠️ Package-name hazard

`npx wallet-cli …` installs **`wallet-cli@0.1.8`** — an unrelated third-party package, not Ledger's.
Observed directly:

```
npm warn exec The following package was not found and will be installed: wallet-cli@0.1.8
Commands: config, init, generate|g, import|i <privateKey>, setProvider, …
```

That package's surface (`import <privateKey>`, `generate`) is nothing like Ledger's and has no
`ring` group. The scoped name `@ledgerhq/wallet-cli` must always be used. Recorded as **FND-011**.

## `ring` command surface (from the binary)

```
Usage: wallet-cli ring [options]
Ledger Key Ring — trustless, hardware-rooted encryption for files and text (LKRP)

Subcommands:
  init     Set up this machine as a Ledger Key Ring member, creating or
           recovering a trustchain (device required).
  encrypt  Encrypt data with a key from your Ledger Key Ring. Files via -i/-o,
           text via stdin/stdout.
  decrypt  Decrypt data with a key from your Ledger Key Ring. Files via -i/-o,
           text via stdin/stdout.
  keys     List the keys you've used on your Ledger Key Ring (local cache, no network).
  destroy  Tear down your Ledger Key Ring on LKRP and wipe local member credentials.
```

Flags that matter:

| Command | Flags |
|---|---|
| `ring init` | `--name/-n` (member name), `--unsecure-no-password`, `--output` |
| `ring encrypt` | `--key/-k` (scoped key name), `--input/-i`, `--out/-o`, `--output` |
| `ring decrypt` | `--key/-k` (must match encrypt), `--input/-i`, `--out/-o`, `--output` |
| `ring keys` | `--output` |

Encryption is **AES-256-GCM** under a key scoped by `--key`.

## Device and network requirements — confirms FND-002

| Operation | Device? | Network? |
|---|---|---|
| `ring init` | **YES — required** | yes (creates/recovers the trustchain) |
| `ring encrypt` / `ring decrypt` | **no** (after init) | **YES — required to restore the trustchain** |
| `ring keys` | no | **no** — local cache only |
| `ring destroy` | no | yes (tears down the remote LKRP application) |

This confirms FND-002 from Phase 0: Key Ring is a **device-provisioned remote key service**, not a
local keystore. Encrypt/decrypt have a network failure mode entirely separate from a missing
password, and both must fail closed.

## `WALLET_PASS`

Confirmed present in the binary's embedded agent skill:

> the `ring` commands read the password from the `WALLET_PASS` env var when there is no TTY. **The
> password itself must be provisioned by the developer/user (exported in the environment or stored
> in the OS keychain) — the agent never chooses, types, or otherwise handles the secret value; it
> only references what the user has already provisioned.**

And for provisioning:

> `ring init` requires a password to protect the ring. `WALLET_PASS` must already be provided in
> the environment by the developer/user before the command runs — **the agent never sets or injects
> it**.

ContextLock follows this literally: no script in this repository writes, generates, prompts for, or
logs `WALLET_PASS`. The secret provider reads it from the ambient environment only, and the secret
scanner fails the build on any literal assignment.

Note `--unsecure-no-password` exists and stores the private key unencrypted in the OS keychain.
ContextLock does **not** use it, and the guidance is explicit that a ring should always be
password-protected.

## Observed fail-closed behaviour (no ring provisioned)

Run on this machine with no ring and no device:

```
$ wallet-cli ring keys --output json
{"ok":false,"error":{"command":"ring keys",
 "message":"Ledger Key Ring not initialized. Run `wallet-cli ring init` first."}}

$ echo "<canary>" | wallet-cli ring encrypt --key contextlock-demo --out /tmp/ctx-enc.bin
{"ok":false,"error":{"kind":"command-execution","name":"CommandExecutionError", …}}

$ ls /tmp/ctx-enc.bin
ls: /tmp/ctx-enc.bin: No such file or directory
```

Two things worth recording: the CLI reports a structured error rather than degrading, and it
produces **no output file at all** on failure. So a caller cannot mistake a failed encrypt for a
successful one, and there is no partially-written artifact to leak.

A separate usability note: `--output json` is rejected for `encrypt`/`decrypt` to stdout, because
binary ciphertext/plaintext cannot be JSON-encoded — `--out <file>` is required with JSON output.
This shapes how the secret provider invokes the CLI.

## What this means for ContextLock

1. `ring init` needs a physical device → **BLK-002** (no device attached to this machine).
2. Broker secret decryption is headless but **network-dependent** → two distinct fail-closed paths,
   both must map to `CTX_LEDGER_UNAVAILABLE` and neither may fall back to plaintext.
3. The agent-facing interface exposes `performProtectedAction(...)`, never `getSecret()`.
4. `WALLET_PASS` is referenced from the environment and never handled by the agent.
