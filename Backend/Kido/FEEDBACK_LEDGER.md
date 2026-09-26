# Ledger Developer Experience Feedback

Written **during** the Phase 6/7 integration, as the build rules require, so this reflects real
friction rather than a retrospective summary. Versions: `@ledgerhq/wallet-cli` 2.1.0
(`@ledgerhq/wallet-cli-darwin-arm64`), `@ledgerhq/device-management-kit` 1.9.0,
`@ledgerhq/device-signer-kit-ethereum` 1.18.0, `@ledgerhq/context-module` 2.5.0. macOS 27 / arm64.

## What worked well

**The `ring` command surface is exactly right for an agent broker.** `encrypt`/`decrypt` operating
on files via `-i`/`-o` or on stdin/stdout, scoped by `--key`, is a small enough interface to wrap
safely. Being able to hold the key name and ciphertext path fixed at construction — so no
per-call parameter can be hijacked — fell out of the CLI's design rather than needing to be
engineered around it.

**Failure behaviour is genuinely fail-closed, and that deserves calling out.** With no ring
provisioned, `ring encrypt` returned a structured error and wrote **no output file at all**:

```
$ echo "<secret>" | wallet-cli ring encrypt --key contextlock-demo --out /tmp/ctx-enc.bin
{"ok":false,"error":{"kind":"command-execution","name":"CommandExecutionError", …}}
$ ls /tmp/ctx-enc.bin
ls: /tmp/ctx-enc.bin: No such file or directory
```

A partially-written or zero-byte output would have been an easy leak/confusion path. It isn't there.

**`--output json` everywhere** made wrapping the CLI straightforward, and `ring keys` being
explicitly "local cache, no network" is a useful, honest distinction.

**The embedded agent-skill guidance on `WALLET_PASS` is excellent and unusually clear:**

> the agent never chooses, types, or otherwise handles the secret value; it only references what
> the user has already provisioned.

That is the right rule, stated unambiguously, in a place an agent will actually encounter it. More
SDKs should ship guidance like this.

## Friction

### 1. `npx wallet-cli` installs someone else's package (highest-impact issue found)

The docs and prize text both say `wallet-cli ring`. Following that literally:

```
$ npx wallet-cli --help
npm warn exec The following package was not found and will be installed: wallet-cli@0.1.8
Commands: config, init, generate|g, import|i <privateKey>, setProvider, ...
```

That is an unrelated third-party tool with no `ring` group — and its surface includes
`import <privateKey>`. A developer or agent following the docs can land on a wallet tool that
accepts raw private keys, while believing they are running Ledger's.

**Suggestion:** write the scoped name in every install instruction —
`npm i -g @ledgerhq/wallet-cli` — and consider a one-line note in the `ring` docs: *"the binary is
called `wallet-cli`, but the package is `@ledgerhq/wallet-cli`; a bare `npx wallet-cli` resolves to
an unrelated package."* This is a five-word docs change that removes a genuine security-adjacent
footgun. Filed in our build as FND-011.

### 2. The device requirement for `ring init` isn't discoverable until you have a device

`ring init --help` says "(device required)", which is correct, but there is no way to get any
further — or to exercise the encrypt/decrypt paths — without hardware. For CI, for contributors
without a device, and for agents, this makes the entire Key Ring path untestable.

**Suggestion:** a `--dry-run` or a documented "ring simulator" mode that exercises the CLI contract
(argument validation, output shapes, error codes) without provisioning a real trustchain. It would
not need to be cryptographically meaningful — just enough to let a wrapper's error handling and
plumbing be tested honestly. Right now the alternative is mocking your own CLI, which tests your
mock rather than the tool.

### 3. The 127 MB platform binary is a surprise

`@ledgerhq/wallet-cli` is a thin launcher that delegates to e.g.
`@ledgerhq/wallet-cli-darwin-arm64`. Installing only the launcher gives a confusing failure, and
the size isn't mentioned up front — relevant for CI images and for anyone on a metered connection.

**Suggestion:** note the platform-package split and approximate size in the install section.

### 4. `--output json` is rejected for `encrypt`/`decrypt` to stdout

```
--output json requires --out <file>: binary ciphertext cannot be written as JSON to stdout.
```

The reasoning is sound, but the interaction is only discoverable by hitting it. It shapes how a
wrapper must be written (temp file rather than pipe), which is a real design constraint.

**Suggestion:** mention it in the `ring encrypt`/`ring decrypt` docs alongside the `-i`/`-o` flags,
or offer base64 JSON output as an opt-in for callers that would rather not touch the filesystem.

### 5. `WALLET_PASS` appears in the embedded skill but not in `--help`

`ring init --help` and `ring encrypt --help` list `--name`, `--key`, `-i`, `-o`, `--output` — but
never mention `WALLET_PASS`, even though it is the mechanism for every non-interactive use. It was
found by extracting strings from the binary and by reading the docs, not from the CLI itself.

**Suggestion:** add a line to the `ring` group help: *"Non-interactive: the password is read from
`WALLET_PASS` when no TTY is present."*

## Time-savers that would have helped most

1. A copy-pasteable **"broker holds a secret, agent never sees it"** worked example — that is the
   pattern the prize text explicitly asks for, and it's the one thing we had to derive from first
   principles. A ~30-line reference wrapper showing `ring decrypt` → use → zeroize would be the
   single highest-value addition to the AI-tools docs.
2. A short statement of **what Key Ring is not**: it isn't a local keystore, and encrypt/decrypt
   need network access to restore the trustchain. We inferred this from a table row; it materially
   changes a consumer's fail-closed design, because there are two distinct outage modes (missing
   password, unreachable ring) rather than one.
3. Clear separation in the docs between **Key Ring** and **device signing**. They're different
   mechanisms for different problems, and the prize text mentions both in one breath. Naming that
   distinction explicitly would help teams avoid conflating them — we kept them in separate
   packages precisely to avoid it.

## Honest status of our own integration

Recorded here so this feedback isn't mistaken for a completion claim: **no physical Ledger device
was available on the build machine** (BLK-002). Everything device-independent is implemented and
tested against the real CLI — the wrapper, the agent boundary, both fail-closed paths, error
sanitization and a 10-prompt exfiltration gauntlet — but `ring init`, and therefore a genuinely
hardware-rooted encrypted credential, was never performed. We have not simulated it with local
AES, because that would be exactly the thing the Key Ring exists to make unnecessary.
