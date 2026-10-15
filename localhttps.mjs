#!/usr/bin/env node
// localhttps: HTTPS on custom local hostnames for dev servers.
//   localhttps add my.test 3000   -> https://my.test proxies to http://localhost:3000
// Certs come from a local CA (~/.localhttps/ca.crt) trusted once. Under WSL the
// hosts entry and CA trust go to the Windows side, so Windows browsers work.
// On macOS the CA goes into the login keychain.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const DIR = process.env.LOCALHTTPS_HOME ?? path.join(os.homedir(), ".localhttps");
const CONFIG = path.join(DIR, "proxies.json");
const CA_KEY = path.join(DIR, "ca.key");
const CA_CRT = path.join(DIR, "ca.crt");
const CA_NAME = "localhttps local CA";
const MARK = "# localhttps";
const DRY_RUN = process.env.LOCALHTTPS_DRY_RUN === "1"; // skip hosts/trust changes
const IS_WSL = fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
const IS_MAC = process.platform === "darwin";
const HOSTS = IS_WSL ? "/mnt/c/Windows/System32/drivers/etc/hosts" : "/etc/hosts";
const EOL = IS_WSL ? "\r\n" : "\n";
// WSL's localhost relay into Linux listens on Windows ::1, not 127.0.0.1.
const HOSTS_IP = IS_WSL ? "::1" : "127.0.0.1";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });

const certPaths = (host) => ({
  key: path.join(DIR, "certs", `${host}.key`),
  crt: path.join(DIR, "certs", `${host}.crt`),
});

const loadConfig = () =>
  fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : {};

const saveConfig = (config) =>
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");

function fail(message) {
  console.error(`localhttps: ${message}`);
  process.exit(1);
}

// --- Windows side (WSL) -----------------------------------------------------

// A file in the Windows %TEMP%, as { win, unix } paths.
function winTemp(name) {
  const dir = run("cmd.exe", ["/c", "echo %TEMP%"], { cwd: "/mnt/c" }).trim();
  const win = `${dir}\\${name}`;
  return { win, unix: run("wslpath", ["-u", win]).trim() };
}

// Run a PowerShell script elevated (UAC prompt). -EncodedCommand avoids quoting.
function powershellAdmin(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-EncodedCommand','${encoded}' -ErrorAction Stop; exit $p.ExitCode`,
  ]);
}

const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;

// --- trust store ------------------------------------------------------------

function nssCertutil(args) {
  const db = path.join(os.homedir(), ".pki", "nssdb");
  if (!fs.existsSync(path.join(db, "cert9.db"))) {
    fs.mkdirSync(db, { recursive: true });
    run("certutil", ["-d", `sql:${db}`, "-N", "--empty-password"]);
  }
  run("certutil", ["-d", `sql:${db}`, ...args]);
}

function trustCA() {
  if (DRY_RUN) return console.log(`[dry run] would trust ${CA_CRT}`);
  if (IS_WSL) {
    const tmp = winTemp("localhttps-ca.crt");
    fs.copyFileSync(CA_CRT, tmp.unix);
    console.log("Confirm the certificate dialog on Windows...");
    run("certutil.exe", ["-user", "-addstore", "Root", tmp.win]);
    fs.rmSync(tmp.unix);
    return;
  }
  if (IS_MAC) {
    console.log("Enter your macOS password to trust the localhttps CA...");
    const keychain = path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
    run("security", ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, CA_CRT], { stdio: "inherit" });
    return;
  }
  try {
    nssCertutil(["-A", "-t", "C,,", "-n", CA_NAME, "-i", CA_CRT]);
  } catch {
    console.warn(
      `Could not trust the CA (install libnss3-tools / nss-tools?).\n` +
        `Import ${CA_CRT} into your browser manually.`,
    );
  }
}

function untrustCA() {
  if (DRY_RUN) return console.log(`[dry run] would untrust ${CA_NAME}`);
  try {
    if (IS_WSL) run("certutil.exe", ["-user", "-delstore", "Root", CA_NAME]);
    else if (IS_MAC) run("security", ["delete-certificate", "-t", "-c", CA_NAME]);
    else nssCertutil(["-D", "-n", CA_NAME]);
  } catch {
    console.warn(`Could not remove "${CA_NAME}" from the trust store; remove it manually.`);
  }
}

// --- certificates -------------------------------------------------------------

function ensureCA() {
  if (fs.existsSync(CA_CRT)) return;
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", CA_KEY, "-out", CA_CRT, "-days", "3650",
    "-subj", `/CN=${CA_NAME}`,
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  fs.chmodSync(CA_KEY, 0o600);
  trustCA();
}

function issueCert(host) {
  const { key, crt } = certPaths(host);
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const csr = run("openssl", [
    "req", "-new", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-subj", `/CN=${host}`,
  ]);
  const ext =
    `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\n` +
    `keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`;
  const extFile = path.join(DIR, "certs", `${host}.ext`);
  fs.writeFileSync(extFile, ext);
  try {
    run(
      "openssl",
      [
        "x509", "-req", "-CA", CA_CRT, "-CAkey", CA_KEY,
        "-set_serial", `0x${Date.now().toString(16)}`,
        "-days", "825", "-extfile", extFile, "-out", crt,
      ],
      { input: csr },
    );
  } finally {
    fs.rmSync(extFile);
  }
}

// --- hosts file -------------------------------------------------------------

function writeHosts(content) {
  if (DRY_RUN) {
    return console.log(`[dry run] would write ${HOSTS}:\n${content}`);
  }
  // Windows hosts is read-only, and the copy keeps that mode: replace, don't overwrite.
  const backup = path.join(DIR, "hosts.bak");
  fs.rmSync(backup, { force: true });
  fs.copyFileSync(HOSTS, backup);
  if (IS_WSL) {
    const tmp = winTemp("localhttps.hosts");
    fs.writeFileSync(tmp.unix, content);
    console.log("Approve the UAC prompt on Windows to update the hosts file...");
    try {
      powershellAdmin(
        `Copy-Item -LiteralPath ${psQuote(tmp.win)} ` +
          `-Destination "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -Force -ErrorAction Stop`,
      );
    } finally {
      fs.rmSync(tmp.unix);
    }
    return;
  }
  const tmp = path.join(DIR, "hosts.new");
  fs.writeFileSync(tmp, content);
  run("sudo", ["cp", tmp, HOSTS], { stdio: "inherit" });
  fs.rmSync(tmp);
  // macOS caches name lookups; flush so the new entry applies now
  if (IS_MAC) run("sudo", ["killall", "-HUP", "mDNSResponder"], { stdio: "inherit" });
}

// Rewrite our marked entries in one write: drop those matching `drop`, ensure
// one entry per host in `add`. One write = one sudo/UAC prompt for many hosts.
function updateHosts({ drop = () => false, add = [] } = {}) {
  const hostOf = (l) => (l.includes(MARK) ? l.trim().split(/\s+/)[1] : null);
  const original = fs.readFileSync(HOSTS, "utf8").split(/\r?\n/);
  let lines = original.filter((l) => !drop(hostOf(l)));
  let changed = lines.length !== original.length;
  const missing = add.filter((h) => !lines.includes(`${HOSTS_IP} ${h} ${MARK}`));
  if (missing.length) {
    // replace any stale localhttps line for these hosts (e.g. old IP)
    lines = lines.filter((l) => !missing.includes(hostOf(l)));
    while (lines.length && lines.at(-1).trim() === "") lines.pop();
    lines.push(...missing.map((h) => `${HOSTS_IP} ${h} ${MARK}`), "");
    changed = true;
  }
  if (changed) writeHosts(lines.join(EOL)); // no change -> no sudo/UAC prompt
}

// --- proxy server -----------------------------------------------------------

function start(port) {
  const contexts = new Map();
  const secureContext = (host) => {
    const { key, crt } = certPaths(host);
    if (!contexts.has(host) && fs.existsSync(crt)) {
      contexts.set(host, tls.createSecureContext({
        key: fs.readFileSync(key),
        cert: fs.readFileSync(crt),
      }));
    }
    return contexts.get(host);
  };
  // ponytail: config re-read per request so `add` applies without restart
  const target = (req) => {
    const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
    return { host, port: loadConfig()[host] };
  };

  const server = https.createServer(
    {
      SNICallback: (name, cb) => {
        const ctx = secureContext(name.toLowerCase());
        ctx ? cb(null, ctx) : cb(new Error(`unknown host ${name}`));
      },
    },
    (req, res) => {
      const t = target(req);
      if (!t.port) {
        res.writeHead(502).end(`localhttps: no proxy for ${t.host}\n`);
        return;
      }
      const upstream = http.request(
        {
          host: "localhost",
          port: t.port,
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            "x-forwarded-proto": "https",
            "x-forwarded-host": req.headers.host,
            "x-forwarded-for": req.socket.remoteAddress,
          },
        },
        (up) => {
          res.writeHead(up.statusCode, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502).end(`localhttps: localhost:${t.port} unreachable (${e.code})\n`);
      });
      req.pipe(upstream);
    },
  );

  // WebSockets (e.g. HMR): replay the upgrade request upstream, then splice.
  server.on("upgrade", (req, socket, head) => {
    const t = target(req);
    if (!t.port) return socket.destroy();
    const up = net.connect(t.port, "localhost", () => {
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      up.write(raw + "\r\n");
      if (head.length) up.write(head);
      up.pipe(socket).pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });

  server.on("error", (e) => {
    if (e.code === "EACCES") {
      fail(
        `no permission for port ${port}. Allow it once with:\n` +
          `  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${port}\n` +
          `(persist: echo net.ipv4.ip_unprivileged_port_start=${port} | sudo tee /etc/sysctl.d/99-localhttps.conf)`,
      );
    }
    if (e.code === "EADDRINUSE") {
      const check = IS_MAC ? `lsof -nP -iTCP:${port} -sTCP:LISTEN` : `ss -ltnp | grep :${port}`;
      fail(`port ${port} is in use (localhttps already running?). Check: ${check}`);
    }
    fail(e.message);
  });

  server.listen(port, () => {
    console.log(`localhttps listening on :${port}`);
    for (const [host, p] of Object.entries(loadConfig())) {
      const suffix = port === 443 ? "" : `:${port}`;
      console.log(`  https://${host}${suffix} -> http://localhost:${p}`);
    }
  });
}

// --- CLI --------------------------------------------------------------------

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const USAGE = `usage:
  localhttps add <hostname> <port> [<hostname> <port> ...]
                                 proxy https://<hostname> to http://localhost:<port>
  localhttps rm <hostname> [...]     remove proxies
  localhttps ls                      list proxies
  localhttps start [port]            run the proxy (default port 443)
  localhttps uninstall               remove all hosts entries, CA trust and ~/.localhttps`;

const [cmd, ...args] = process.argv.slice(2);
const config = loadConfig();

switch (cmd) {
  case "add": {
    // localhttps add <host> <port> [<host> <port> ...]; validate all before changing anything
    if (!args.length || args.length % 2) fail("expected <hostname> <port> pairs");
    const pairs = [];
    for (let i = 0; i < args.length; i += 2) {
      const host = args[i].toLowerCase();
      const port = Number(args[i + 1]);
      if (!HOST_RE.test(host)) fail(`invalid hostname "${args[i]}" (e.g. my.test)`);
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port "${args[i + 1]}"`);
      pairs.push([host, port]);
    }
    ensureCA();
    pairs.forEach(([host]) => issueCert(host));
    updateHosts({ add: pairs.map(([host]) => host) });
    saveConfig({ ...config, ...Object.fromEntries(pairs) });
    for (const [host, port] of pairs) console.log(`https://${host} -> http://localhost:${port}`);
    console.log("Run `localhttps start` if it isn't running.");
    break;
  }
  case "rm": {
    const hosts = args.map((h) => h.toLowerCase());
    if (!hosts.length) fail("expected at least one hostname");
    const unknown = hosts.filter((h) => !config[h]);
    if (unknown.length) fail(`no proxy for ${unknown.join(", ")}`);
    updateHosts({ drop: (h) => hosts.includes(h) });
    for (const host of hosts) {
      const { key, crt } = certPaths(host);
      fs.rmSync(key, { force: true });
      fs.rmSync(crt, { force: true });
      delete config[host];
      console.log(`removed ${host}`);
    }
    saveConfig(config);
    break;
  }
  case "ls":
    for (const [host, port] of Object.entries(config)) {
      console.log(`${host} -> localhost:${port}`);
    }
    break;
  case "start":
    start(Number(args[0] ?? 443));
    break;
  case "uninstall":
    updateHosts({ drop: () => true });
    if (fs.existsSync(CA_CRT)) untrustCA();
    if (!DRY_RUN) fs.rmSync(DIR, { recursive: true, force: true });
    console.log("localhttps removed");
    break;
  default:
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
}
