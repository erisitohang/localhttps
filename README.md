# localhttps

HTTPS on custom local hostnames for dev servers. One Node file, no dependencies.

```bash
localhttps add my.test 3000   # https://my.test -> http://localhost:3000
localhttps add app.test 3000 api.test 3001   # several at once: one sudo/UAC prompt
localhttps start              # run the proxy on :443
```

## Commands

| Command | What it does |
|---|---|
| `localhttps add <hostname> <port> [<hostname> <port> ...]` | Issue certs, add hosts entries (one prompt for all), register the proxies |
| `localhttps rm <hostname> [...]` | Remove hosts entries, certs and proxies |
| `localhttps ls` | List proxies |
| `localhttps start [port]` | Run the HTTPS proxy (default 443) |
| `localhttps uninstall` | Remove all localhttps hosts entries, the CA trust and `~/.localhttps` |

## How it works

- **Local CA.** The first `add` creates `~/.localhttps/ca.crt` + `ca.key` and trusts the CA once. Each hostname gets a leaf cert signed by it, so later `add`s need no certificate prompt.
- **Hosts file.** `add` appends `127.0.0.1 <hostname> # localhttps` (`::1` under WSL, where Windows→WSL localhost forwarding only listens on IPv6 loopback). Only lines with that marker are ever edited or removed. A backup of the previous file is kept at `~/.localhttps/hosts.bak`.
- **Proxy.** `start` is a single HTTPS server that picks the cert by hostname (SNI) and forwards to `http://localhost:<port>`, including WebSockets (HMR). It sets `X-Forwarded-Proto/Host/For`. Proxies added while it runs work without a restart.

## Platforms

- **WSL**: the hosts entry and CA trust go to the **Windows** side, so Chrome/Edge on Windows work. Expect a UAC prompt when the hosts file changes and a certificate dialog the first time. WSL forwards Windows `localhost:443` to the proxy running in WSL; your dev server must listen on `localhost` in WSL.
- **Linux**: `/etc/hosts` via `sudo`; the CA is trusted in the NSS db `~/.pki/nssdb` (Chrome/Chromium). Needs `certutil` from `libnss3-tools` (Debian/Ubuntu) or `nss-tools` (Fedora). Firefox: import `~/.localhttps/ca.crt` manually.
- **macOS**: `/etc/hosts` via `sudo` (then flushes the DNS cache); the CA is trusted in the login keychain (password prompt on first `add`), which Safari and Chrome use. Firefox: import `~/.localhttps/ca.crt` manually, or set `security.enterprise_roots.enabled` to `true`. Port 443 binds without privilege on macOS 10.14+.
- Native Windows is not supported.

Requires Node 20+ and `openssl`.

## Install

```bash
git clone <this repo> && cd localhttps
npm link            # puts `localhttps` on PATH
```

Port 443 needs privilege on Linux (not macOS). Allow unprivileged binding once:

```bash
echo net.ipv4.ip_unprivileged_port_start=443 | sudo tee /etc/sysctl.d/99-localhttps.conf
sudo sysctl --system
```

Or use another port: `localhttps start 8443` and open `https://my.test:8443`.

## Troubleshooting

- **`no permission for port 443`**: apply the sysctl above, or use another port.
- **`curl.exe` on Windows fails with `CRYPT_E_NO_REVOCATION_CHECK`**: Schannel wants a revocation check the local CA can't provide. Use `curl.exe --ssl-no-revoke`; browsers are unaffected.
- **Browser says the cert is untrusted**: the CA trust step was skipped or declined. Run `localhttps uninstall`, then `add` again and accept the dialog. On Linux, check `certutil` is installed; on macOS, check Keychain Access shows "localhttps local CA" as trusted.
- **`localhost:<port> unreachable`**: the dev server isn't running, or it listens on a different port.
- **Hostname doesn't resolve in the browser**: check the hosts file contains the `# localhttps` line; browsers cache DNS briefly, so retry after a minute.

## Testing without touching the system

`LOCALHTTPS_DRY_RUN=1` prints hosts/trust changes instead of applying them; `LOCALHTTPS_HOME` moves the state dir.

```bash
LOCALHTTPS_HOME=/tmp/dt LOCALHTTPS_DRY_RUN=1 node localhttps.mjs add my.test 3000
LOCALHTTPS_HOME=/tmp/dt node localhttps.mjs start 8443
curl --resolve my.test:8443:127.0.0.1 --cacert /tmp/dt/ca.crt https://my.test:8443/
```

## Security

`~/.localhttps/ca.key` can sign certificates your browser trusts. It stays on your machine with `0600` permissions. Don't share it; `localhttps uninstall` removes both the trust and the key.

## License

MIT
