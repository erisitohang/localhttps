# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`localhttps`: a CLI that gives local dev servers HTTPS on custom hostnames (`localhttps add my.test 3000` → `https://my.test`). Everything lives in one dependency-free ES module, `localhttps.mjs`. Keep it that way: Node built-ins plus the `openssl` CLI only, no npm dependencies, no build step.

## Commands

```bash
node localhttps.mjs              # usage
npm link                         # install `localhttps` on PATH
```

There is no test suite. Verify changes with a dry-run end-to-end check, which never touches the hosts file or trust store:

```bash
export LOCALHTTPS_HOME=/tmp/dt LOCALHTTPS_DRY_RUN=1
node localhttps.mjs add my.test 3999
openssl verify -CAfile /tmp/dt/ca.crt /tmp/dt/certs/my.test.crt
node -e 'require("http").createServer((q,s)=>s.end("ok")).listen(3999)' &
node localhttps.mjs start 8443 &
curl --resolve my.test:8443:127.0.0.1 --cacert /tmp/dt/ca.crt https://my.test:8443/
```

Never run without `LOCALHTTPS_DRY_RUN=1` while testing: real runs edit the Windows hosts file (UAC prompt) or `/etc/hosts` (sudo) and change the user's certificate trust store.

## Architecture

`localhttps.mjs` sections, top to bottom:

- **Windows side (WSL)**: `winTemp` (file in Windows `%TEMP%` as `{win, unix}` paths) and `powershellAdmin` (elevated PowerShell via `Start-Process -Verb RunAs`; the inner script goes through `-EncodedCommand`, UTF-16LE base64, to avoid nested quoting). Windows tools can't reliably read WSL paths when elevated, so files are staged in `%TEMP%` first.
- **Trust store**: `trustCA` / `untrustCA`. WSL uses `certutil.exe -user` on `CurrentUser\Root`; macOS uses `security add-trusted-cert` on the login keychain; Linux uses NSS `certutil` on `~/.pki/nssdb` (`nssCertutil` creates the db if missing). The CA is identified by its CN, `localhttps local CA`.
- **Certificates**: `ensureCA` (creates and trusts the CA once), `issueCert` (leaf with SAN + `serverAuth`, signed by the CA, 825 days). Files live in `~/.localhttps/certs/<host>.{key,crt}`.
- **Hosts file**: `updateHosts` only touches lines containing the `# localhttps` marker and calls `writeHosts` only if something changed, so no-op commands never prompt for sudo/UAC. WSL writes CRLF and maps hosts to `::1` (`HOSTS_IP`): Windows→WSL localhost forwarding listens on IPv6 loopback only, so `127.0.0.1` can't connect. `add` replaces a stale marked line for the same host.
- **Proxy server**: `start` is an `https` server using `SNICallback` for per-host certs, forwarding to `http://localhost:<port>`. WebSocket upgrades are replayed raw over `net.connect` and spliced. `proxies.json` is re-read per request, so `add` takes effect without a restart.
- **CLI**: `switch` on `process.argv`. `add`/`rm` take several hosts; all args are validated before anything changes, and `updateHosts` gets the whole list so the hosts file is written once. State is `~/.localhttps/proxies.json`, a flat `{ "hostname": port }` map.

Platform detection: `IS_WSL` checks `/proc/sys/fs/binfmt_misc/WSLInterop`; `IS_MAC` is `process.platform === "darwin"`. macOS shares the Linux `/etc/hosts` + `sudo` path and also flushes `mDNSResponder`. Under WSL the *Windows* hosts file and trust store are the targets, because the browser runs on Windows; WSL's localhost forwarding carries Windows `[::1]:443` into the proxy.

## Rules

- Validate hostnames (`HOST_RE`) and ports before they reach `openssl`, hosts files or PowerShell. Pass arguments as arrays to `execFileSync`, never via a shell string.
- Anything that edits the hosts file or trust store must respect `LOCALHTTPS_DRY_RUN`.
- Keep `~/.localhttps/ca.key` at `0600`; never log or copy it.
- Native Windows isn't supported. If you add it, branch next to the existing WSL/macOS/Linux code rather than abstracting.
- Keep README.md in sync with any command or behavior change.
