/**
 * dsh-desktop host sidecar (portless bridge).
 *
 * Boots the shipped `web` profile IN-PROCESS with the webserver row disabled
 * and a route-registry stub (no TCP listener, no port). The frontend dist is
 * materialized beside the app data directory; every HTTP/WebSocket
 * request from the webview arrives from the Rust shell as NDJSON frames on
 * this process' stdin and is dispatched straight to the in-process routes,
 * mirroring deepseek-harness-desktop-windows' IPC transport.
 *
 * stdout is reserved for the NDJSON bridge protocol. All human logs go to
 * stderr (the Rust shell forwards them to the app log file).
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format } from 'node:util';

import { createIpcWebServer } from './ipc-web-server.mjs';
import { createDesktopPnpmService, createDesktopProfilesService } from './desktop-pnpm.mjs';
import { renderAboutClient } from './desktop-about-template.mjs';
import {
  OP_BINARY,
  OP_PING,
  OP_PONG,
  OP_TEXT,
  ServerFrameDecoder,
  createMockSocket,
  encodeClientFrame,
} from './ws-ipc.mjs';

// Cross-platform env read: DSH_DESKTOP_* wins, DSH_MAC_* kept for legacy.
const dshenv = (name, legacy) => process.env[name] ?? process.env[legacy];

// ---------------------------------------------------------------------------
// package resolution: all dsh packages resolve from the installed dsh root.
// ---------------------------------------------------------------------------
const DSH_ROOT = (() => {
  // The Rust shell always injects DSH_DESKTOP_DSH_ROOT (it resolves the user's
  // global install and fails fast otherwise); the env/flag fallbacks exist
  // for running the sidecar standalone during development.
  if (dshenv('DSH_DESKTOP_DSH_ROOT', 'DSH_MAC_DSH_ROOT')) {
    return dshenv('DSH_DESKTOP_DSH_ROOT', 'DSH_MAC_DSH_ROOT');
  }
  const bin = dshenv('DSH_DESKTOP_DSH_BIN', 'DSH_MAC_DSH_BIN') ?? '';
  const marker = join('/node_modules', '@deepseek-ai', 'dsh') + join('/lib', 'bin.js');
  if (bin.endsWith(marker)) return dirname(dirname(bin));
  throw new Error('dsh package root not found (set DSH_DESKTOP_DSH_ROOT).');
})();

const pkgRequire = createRequire(pathToFileURL(join(DSH_ROOT, 'package.json')));
const resolvePackage = (id) => pkgRequire.resolve(id);
const importPackage = async (id) => import(pathToFileURL(resolvePackage(id)).href);
const INSTALL_ANCHOR = resolvePackage('@deepseek-ai/dsh/package.json');

const [{ boot, composeEntries, healProfilesModuleFallback, loadLayeredEnv, loadOptionalPatches, loadProfile, PROFILE_PATCH_FILENAME }, { resolveDshHome }, { DSH_LAUNCH_ENVIRONMENT_KEY }, { provideCmdline }] = await Promise.all([
  importPackage('@deepseek-ai/dsh-app-boot'),
  importPackage('@deepseek-ai/dsh-home-paths'),
  importPackage('@deepseek-ai/dsh-launch-environment'),
  importPackage('@deepseek-ai/dsh-cmdline'),
]);

// Structured index-injection renderer, shared verbatim with the CLI's real
// webserver so the desktop boots the same `window.__ModuleLoader__` facade.
const { renderIndexInjections } = await importPackage('@deepseek-ai/dsh-host-webserver');

// Default to the CLI's `web` profile so the desktop app sees the same
// sessions, installed plugins and settings as `dsh web`. Override with
// DSH_DESKTOP_PROFILE for an isolated desktop profile.
const NAME = (dshenv('DSH_DESKTOP_PROFILE', 'DSH_MAC_PROFILE') ?? 'web').trim() || 'web';
const TELEMETRY_ROW_ID = 'session-telemetry-otel';
const PROFILE_ROOT_FILENAME = 'cordis.yml';
const PROFILE_ROOT_CONFIG = [
  '# dsh profile root — an empty entry list. The tree is composed as patches:',
  "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then",
  '# --patch overlays. Edit cordis.patch.yml, not this file.',
  '[]',
  '',
].join('\n');
const WWW_DIR = dshenv('DSH_DESKTOP_WWW_DIR', 'DSH_MAC_WWW_DIR') ?? join(resolveDshHome(), 'desktop-www');
const HOME_PATCH_PATH = () => join(resolveDshHome(), PROFILE_PATCH_FILENAME);

// The desktop rows in the web settings panel ship as a tiny client-only
// bundle, materialized into the active profile's node_modules at boot so the
// official client-modules graph picks it up like any other web plugin. The
// app version travels from the Rust shell (DSH_DESKTOP_APP_VERSION); the extra
// bundle revision forces a refresh when the generated client code changes
// without an app version bump.
const ABOUT_PACKAGE = '@dsh-desktop/desktop-about';
const ABOUT_VERSION = (dshenv('DSH_DESKTOP_APP_VERSION', 'DSH_MAC_APP_VERSION') ?? '0.0.0').trim() || '0.0.0';
const ABOUT_BUNDLE_REVISION = 12;

/** Write/refresh the desktop settings client bundle under the profile. */
function ensureDesktopAboutBundle(profileDir) {
  const pkgDir = join(profileDir, 'node_modules', ...ABOUT_PACKAGE.split('/'));
  const pkgPath = join(pkgDir, 'package.json');
  const clientPath = join(pkgDir, 'lib', 'client.js');
  try {
    const previous = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (
      previous?.version === ABOUT_VERSION &&
      previous?.dshDesktopBundleRevision === ABOUT_BUNDLE_REVISION &&
      existsSync(clientPath) &&
      existsSync(join(pkgDir, 'lib', 'index.js'))
    ) {
      return;
    }
  } catch {
    /* first boot or malformed previous copy: rewrite below */
  }
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(pkgPath, `${JSON.stringify({
    name: ABOUT_PACKAGE,
    version: ABOUT_VERSION,
    private: true,
    type: 'module',
    main: 'lib/index.js',
    dshDesktopBundleRevision: ABOUT_BUNDLE_REVISION,
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    dsh: {
      client: {
        platform: 'web',
        inject: [],
      },
    },
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(pkgDir, 'lib', 'index.js'), `export const name = ${JSON.stringify(ABOUT_PACKAGE)};\nexport function apply() {}\n`, 'utf8');
  writeFileSync(clientPath, renderAboutClient(JSON.stringify(ABOUT_VERSION)), 'utf8');
}

/** Desktop overlay: HTTP out, IPC in (same shape as the Windows carrier). */
const DESKTOP_PATCHES = [
  { id: 'webserver', disabled: true },
  {
    id: 'web-runtime',
    // The desktop shell IS the Web UI: no URL line and, critically, no
    // default-browser handoff. openBrowser must be pinned false here — the
    // zod default is true, and the bundle's cmdline binding is not consulted
    // once this overlay supplies a literal config, which is why `--no-open`
    // on the command line alone did not stop the browser from opening.
    config: { printUrl: false, surfaceContext: false, trustedHosts: [], openBrowser: false },
  },
  { id: 'client-hmr', disabled: true },
  { insert: [{ id: 'desktop-version', name: ABOUT_PACKAGE }] },
];

const MAX_WS_SEND_BYTES = 1 << 20;

// Keep stdout clean: the parent Rust shell treats stdout as NDJSON only.
for (const key of ['log', 'info', 'warn', 'error', 'debug']) {
  console[key] = (...args) => process.stderr.write(`${format(...args)}\n`);
}

function frame(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Startup/lifecycle status for the Rust recovery page (stage + detail). */
function statusFrame(stage, detail) {
  frame({ type: 'status', stage, detail: String(detail ?? '') });
}

/**
 * Bulk response bytes travel as a JSON header line plus `len` raw bytes
 * (chunk-bin), avoiding base64 encode/decode and 33% size inflation on the
 * bridge. stdout writes are FIFO, so the Rust reader sees header then bytes.
 */
function frameBinChunk(id, chunk) {
  process.stdout.write(`${JSON.stringify({ type: 'chunk-bin', id, len: chunk.byteLength })}\n`);
  process.stdout.write(chunk);
}

// ---------------------------------------------------------------------------
// site preparation
// ---------------------------------------------------------------------------
function copyIfChanged(source, dest) {
  try {
    const s = statSync(source);
    try {
      const d = statSync(dest);
      if (d.size === s.size && d.mtimeMs === s.mtimeMs) return false;
    } catch {
      /* dest missing: copy below */
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

function prepareSite({ webServer, clientModules, wwwDir }) {
  const distIndex = resolvePackage('@deepseek-ai/dsh-web-frontend/dist/index.html');
  const distDir = dirname(distIndex);
  cpSync(distDir, wwwDir, {
    recursive: true,
    filter: (src) => src !== distIndex,
  });

  let html = readFileSync(distIndex, 'utf8');
  // Render the structured `webserver/index-inject` rows (window.__ModuleLoader__
  // facade + __DSH_BOOT__ graph + theme bootstrap), then raw index taps —
  // exactly what the CLI's webserver does, via the shared renderer.
  html = webServer.renderIndex(html);
  // dsh:// is a standard, secure origin: keep the dist's absolute paths and
  // only repoint plugin bundle URLs, exactly like the Windows app:// path.
  html = html.replace(/\/plugins\//g, '/__plugins/');
  html = html.replace(/(client\.js)\?rev=[0-9a-f]{12}/g, '$1');
  // The bridge must exist before any client module executes.
  html = html.replace(/<head>/i, '<head>\n<script src="/__tauri_bridge.js"></script>');
  writeFileSync(join(wwwDir, 'index.html'), html, 'utf8');

  const graph = clientModules.graph();
  for (const entry of graph.entries) {
    const clientPath = clientModules.clientPath(entry.id) ?? '';
    if (clientPath === '') continue;
    const dest = join(wwwDir, '__plugins', ...entry.id.split('/'), 'client.js');
    copyIfChanged(clientPath, dest);
  }

  return { indexPath: join(wwwDir, 'index.html'), graph };
}

// ---------------------------------------------------------------------------
// in-process boot
// ---------------------------------------------------------------------------
const webServer = createIpcWebServer(renderIndexInjections);

async function bootHost() {
  const homeGuess = process.env.HOME ?? process.env.USERPROFILE ?? '/';
  const cwd = dshenv('DSH_DESKTOP_CWD', 'DSH_MAC_CWD') ?? homeGuess;
  process.chdir(cwd);

  const profile = loadProfile(NAME, 'web', INSTALL_ANCHOR, undefined, { userLayer: true });
  // dsh >= 0.1.2-rc.1: healProfilesModuleFallback 改为 async 对象参数
  // { installAnchor, profile?, home? }，见官方 profile-boot 用法。
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile });
  console.error('[host] boot: profile loaded, module fallback healed');
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG);
  ensureDesktopAboutBundle(profile.dir);
  // DSH Desktop 2.x public Host services. Their presence is how cross-
  // environment package managers (dshmarket 1.6+) recognize this in-process
  // host; without them they fall back to spawning a PATH `dsh` and apps
  // launched from Finder/Dock fail with `spawn dsh ENOENT`.
  const desktopProfiles = createDesktopProfilesService({ name: NAME, dir: profile.dir });
  const desktopPnpm = createDesktopPnpmService({
    profileDir: profile.dir,
    profileName: NAME,
    dshBin: join(DSH_ROOT, 'lib', 'bin.js'),
    logLine: (line) => console.error(`[desktop-pnpm] ${line}`),
  });
  const homePatches = loadOptionalPatches(NAME, HOME_PATCH_PATH()) ?? [];
  const bundlePatches = profile.layers.flatMap((layer) => layer.patches);

  const rows = new Map();
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, DESKTOP_PATCHES])) {
    if (typeof row.id === 'string') rows.set(row.id, row);
  }
  const overlays = [...DESKTOP_PATCHES];
  if (rows.has('agent-presets')) {
    overlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}),
        roots: [{ path: join(DSH_ROOT, 'config', 'agent-presets'), trust: 'system' }],
      },
    });
  }
  const telemetryPatch =
    (process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)
      ? { id: TELEMETRY_ROW_ID, disabled: true }
      : undefined;
  if (telemetryPatch !== undefined) overlays.push(telemetryPatch);

  const patches = [...bundlePatches, ...profile.patches, ...homePatches, ...overlays];
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME);

  const ctx = await boot(NAME, rootConfig, patches, (hostCtx) => {
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv(NAME));
    // The desktop shell IS the Web UI: never hand off to the system default
    // browser. Without --no-open, dsh-web-app boots with openBrowser=true and
    // opens the portless mock origin (http://127.0.0.1:0/) in the browser on
    // every launch.
    provideCmdline(hostCtx, { args: ["--no-open"], exit: (code) => process.exit(code) });
    hostCtx.provide('webServer', webServer);
    hostCtx.provide('desktopProfiles', desktopProfiles);
    hostCtx.provide('desktopPnpm', desktopPnpm);
  });
  console.error('[host] boot: tree settled');
  // The IPC webServer emits `webserver/index-inject` on the settled host
  // context; every subscriber (client-modules, theme) has registered by now.
  webServer.attachContext(ctx);
  // dsh >= 0.1.2-rc.1 fences /api/* behind BrowserAuth (launch-token cookie
  // exchange). Resolve the connection service so the bridge can mint session
  // cookies for the embedded WebView (see ensureBridgeAuthCookie).
  try {
    const conn = ctx.connection ?? ctx.resolve?.('connection') ?? null;
    bridgeBrowserAuth = conn?.browserAuth ?? null;
    console.error(
      `[host] browser-auth: ${bridgeBrowserAuth ? 'available' : `unavailable (connection=${typeof conn})`}`,
    );
  } catch (error) {
    console.error(`[host] browser-auth resolve failed: ${error?.message ?? error}`);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// mock node:http req/res used by the in-process route registry
// ---------------------------------------------------------------------------
function mockEventTarget() {
  const listeners = new Map();
  return {
    _mockListeners: listeners,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return this;
    },
    once(event, fn) {
      const wrapped = (...args) => {
        this.off(event, wrapped);
        fn(...args);
      };
      return this.on(event, wrapped);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
      return this;
    },
    removeListener(event, fn) {
      return this.off(event, fn);
    },
    removeAllListeners(event) {
      if (event === undefined) listeners.clear();
      else listeners.delete(event);
      return this;
    },
    addListener(event, fn) {
      return this.on(event, fn);
    },
    emit(event, ...args) {
      let called = false;
      for (const fn of [...(listeners.get(event) ?? [])]) {
        called = true;
        fn(...args);
      }
      return called;
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    eventNames() {
      return [...listeners.keys()];
    },
  };
}

function createMockRequest({ url, method, headers, body }) {
  let destroyed = false;
  // One-shot body consumption gate shared by the on('data') pump and the
  // async iterator, mirroring node:http streams: whichever channel reads the
  // body first wins, the other sees nothing (never double-deliver).
  const hasBody = body !== undefined && body !== null && body.byteLength > 0;
  let bodyConsumed = false;
  const socket = {
    ...mockEventTarget(),
    remoteAddress: '127.0.0.1',
    remotePort: 0,
    localAddress: '127.0.0.1',
    localPort: 0,
    remoteFamily: 'IPv4',
    encrypted: false,
    destroy() {
      this.emit('close');
    },
  };
  const req = {
    ...mockEventTarget(),
    method,
    url,
    headers: { ...headers, host: '127.0.0.1' },
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    socket,
    connection: socket,
    aborted: false,
    // node:http semantics: a bodyless request is fully received by the time
    // the handler runs; a body-bearing request completes only once the body
    // has been consumed ('end' emitted, complete=true).
    complete: !hasBody,
    readableEnded: !hasBody,
    rawHeaders: Object.entries(headers ?? {}).flatMap(([key, value]) => [key, String(value)]),
    destroyed,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      this.destroyed = true;
      this.aborted = true;
      this.socket.destroy();
      this.emit('close');
    },
    async *[Symbol.asyncIterator]() {
      if (bodyConsumed) return;
      bodyConsumed = true;
      if (!hasBody) return;
      yield Buffer.from(body);
      req.complete = true;
      req.readableEnded = true;
      req.emit('end');
    },
  };
  // Classic readable-stream semantics: the body is pumped through
  // 'data'/'end' events once the handler attaches its first 'data' listener
  // (plugins like dsh-remote's readBody wait on req.on('data') + req.on('end')
  // and hang forever without this channel). Emission is deferred one turn so
  // handlers that register 'data' and 'end' synchronously never miss 'end'.
  const baseOn = req.on;
  let pumpScheduled = false;
  req.on = function (event, fn) {
    const result = baseOn.call(req, event, fn);
    if (event === 'data' && !pumpScheduled && !bodyConsumed) {
      pumpScheduled = true;
      setImmediate(() => {
        if (bodyConsumed) return;
        bodyConsumed = true;
        if (hasBody) req.emit('data', Buffer.from(body));
        req.complete = true;
        req.readableEnded = true;
        req.emit('end');
      });
    }
    return result;
  };
  return req;
}

function createMockResponse({ onChunk, onHeaders, onEnd } = {}) {
  // Header storage mirrors node:http's case-insensitive namespace:
  // `_headers` keeps the ORIGINAL key casing (what goes on the wire / into
  // the headers frame, so existing writeHead flows stay byte-identical),
  // while `_index` maps lowercase names to the current key so setHeader(),
  // writeHead(), getHeader(), hasHeader(), removeHeader() and appendHeader()
  // all interoperate regardless of casing.
  const _headers = {};
  const _index = new Map();
  const dropHeader = (name) => {
    const key = _index.get(name);
    if (key !== undefined) {
      delete _headers[key];
      _index.delete(name);
    }
  };
  const res = {
    ...mockEventTarget(),
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    _chunks: [],
    _headers,
    // node:http flushes implicit headers on the first write()/end() when the
    // handler never calls writeHead() (dsh-remote's sendJson only calls
    // setHeader + end). Flushing here guarantees the renderer always receives
    // the status/headers frame BEFORE any body/end frame, so api() can parse
    // the JSON body instead of falling back to a bare "HTTP 500".
    sendHeaders() {
      if (res.headersSent) return;
      res.headersSent = true;
      onHeaders?.();
    },
    writeHead(status, statusMessage, headers) {
      if (res.headersSent || res.writableEnded) return res;
      res.statusCode = status;
      // Accept both node:http forms: writeHead(status, headers) and
      // writeHead(status, statusMessage, headers). The mock never serializes a
      // statusMessage, so a string second argument is ignored.
      if (typeof statusMessage === 'string') {
        if (headers === undefined) headers = null;
      } else if (statusMessage !== undefined && statusMessage !== null) {
        headers = statusMessage;
      }
      // Merge case-insensitively (node:http semantics): the headers object
      // shares one lowercase namespace with setHeader()/appendHeader() and —
      // as in node:http — takes precedence over previously set values, so
      // 'Content-Type' set via setHeader() can never survive as a duplicate
      // differently-cased key after writeHead().
      for (const [key, value] of Object.entries(headers ?? {})) {
        if (value === undefined || value === null) continue;
        const name = String(key).toLowerCase();
        const existing = _index.get(name);
        if (existing !== undefined && existing !== key) delete _headers[existing];
        _headers[key] = value;
        _index.set(name, key);
      }
      res.headersSent = true;
      onHeaders?.();
      return res;
    },
    setHeader(name, value) {
      const key = String(name).toLowerCase();
      dropHeader(key);
      _headers[key] = value;
      _index.set(key, key);
      return res;
    },
    appendHeader(name, value) {
      const key = String(name).toLowerCase();
      const existingKey = _index.get(key);
      if (existingKey === undefined) {
        _headers[key] = value;
        _index.set(key, key);
      } else if (Array.isArray(_headers[existingKey])) {
        _headers[existingKey].push(value);
      } else {
        _headers[existingKey] = [_headers[existingKey], value];
      }
    },
    getHeader(name) {
      const existingKey = _index.get(String(name).toLowerCase());
      return existingKey === undefined ? undefined : _headers[existingKey];
    },
    getHeaders() {
      return { ..._headers };
    },
    getHeaderNames() {
      return Object.keys(_headers);
    },
    hasHeader(name) {
      return _index.has(String(name).toLowerCase());
    },
    removeHeader(name) {
      dropHeader(String(name).toLowerCase());
      return res;
    },
    flushHeaders() {
      res.sendHeaders();
      return res;
    },
    write(chunk) {
      if (res.writableEnded || res.destroyed) return false;
      res.sendHeaders();
      const buffer = chunk === undefined ? undefined : Buffer.from(chunk);
      if (buffer !== undefined) {
        res._chunks.push(buffer);
        onChunk?.(buffer);
      }
      return true;
    },
    end(chunk) {
      if (res.writableEnded || res.destroyed) return;
      res.sendHeaders();
      res.writableEnded = true;
      if (chunk !== undefined) {
        const buffer = Buffer.from(chunk);
        res._chunks.push(buffer);
        onChunk?.(buffer);
      }
      onEnd?.();
    },
    destroy() {
      if (res.writableEnded || res.destroyed) return;
      res.destroyed = true;
      res.emit('close');
      onEnd?.();
    },
  };
  return res;
}

function routeFor(url) {
  const rawPath = new URL(url, 'http://dsh.internal').pathname;
  // The rendered HTML repoints plugin bundle URLs to /__plugins/ so the
  // shell's static fast path serves the copied bundles. dsh >= 0.1.2-rc.1
  // additionally emits combo batch URLs (`/plugins/??a,b&rev=…`) that no
  // static file can satisfy — map any /__plugins/ request back onto the
  // real /plugins/ route (client-modules' serveBundle) so both the single
  // and combo forms resolve. The query string is kept verbatim: serveBundle
  // keys its response cache on pathname+search.
  const routePath = rawPath.startsWith('/__plugins')
    ? `/plugins${rawPath.slice('/__plugins'.length)}`
    : rawPath;
  return webServer.match(routePath) ?? webServer.fallbackHandler();
}

function dispatchRoute(route, req, res) {
  if (typeof route === 'function') return route(req, res);
  return route?.handler(req, res);
}

// ---------------------------------------------------------------------------
// fetch dispatch: copies the Electron IPC bridge's upstream path.
// ---------------------------------------------------------------------------
const pendingFetches = new Map();

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lower = key.toLowerCase();
    if (lower === 'origin' || lower === 'referer' || lower.startsWith('sec-fetch-')) continue;
    if (value !== undefined && value !== null) out[lower] = String(value);
  }
  // Plugin routes (e.g. dshmarket's mutating endpoints) run a CSRF-style
  // check: the Origin header's host must equal the Host header. The portless
  // bridge strips the webview's dsh:// origin, so synthesize the same pair a
  // browser on the real `dsh web` server would send — otherwise every
  // install/update/use-skin call fails with 403 "untrusted origin".
  out.host = '127.0.0.1';
  out.origin = 'http://127.0.0.1';
  return out;
}

function resumeFetch(id) {
  const pending = pendingFetches.get(id);
  if (pending === undefined) return;
  if (pending.sentEnd === false) {
    pending.sentEnd = true;
    frame({ type: 'end', id });
  }
  pendingFetches.delete(id);
}

// --- desktop bridge browser-auth -------------------------------------------
// Resolved after boot; null when the connection plugin exposes no BrowserAuth
// (dsh < 0.1.2-rc.1). authority (raw Host header) -> "name=value" cookie.
let bridgeBrowserAuth = null;
const bridgeAuthCookies = new Map();

function ensureBridgeAuthCookie(host) {
  if (!host || bridgeBrowserAuth === null) return undefined;
  let cookie = bridgeAuthCookies.get(host);
  if (cookie !== undefined) return cookie;
  const captured = {};
  const res = {
    writeHead(status, headers) {
      captured.status = status;
      Object.assign(captured, headers);
    },
    end() {},
  };
  const req = {
    method: 'GET',
    url: `/?token=${encodeURIComponent(bridgeBrowserAuth.launchToken)}`,
    headers: { host },
  };
  bridgeBrowserAuth.authorizeIndex(req, res);
  const raw = captured['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || captured.status !== 303) {
    console.error(`[host] browser-auth mint failed (status=${captured.status})`);
    return undefined;
  }
  cookie = value.split(';')[0];
  bridgeAuthCookies.set(host, cookie);
  return cookie;
}

function handleFetch(msg) {
  // The rendered HTML repoints plugin bundle URLs to /__plugins/ for the
  // shell's static fast path. Requests that still reach the sidecar (combo
  // batch URLs like /__plugins/??a,b&rev=… have no static file) must be
  // rewritten back to the real /plugins/ prefix BEFORE the mock request is
  // built: serveBundle keys its response cache on pathname+search, so a
  // rewritten route with an unrewritten req.url would miss and 404.
  const rawUrl = msg.url ?? '/';
  const url = rawUrl.startsWith('/__plugins')
    ? `/plugins${rawUrl.slice('/__plugins'.length)}`
    : rawUrl;
  const traceDescribe = url.includes('/api/host.describe');
  const res = createMockResponse({
    onHeaders() {
      if (dshenv('DSH_DESKTOP_TRACE_BRIDGE', 'DSH_MAC_TRACE_BRIDGE') === '1') {
        const ct = res.getHeader && (res.getHeader('content-type') ?? res._headers?.['content-type']);
        console.error(`[host-trace] <- ${res.statusCode} ct=${ct} ${url.slice(0, 140)}`);
      }
      frame({
        type: 'headers',
        id: msg.id,
        status: res.statusCode,
        headers: res._headers,
      });
    },
    onChunk(chunk) {
      frameBinChunk(msg.id, chunk);
    },
    onEnd() {
      if (traceDescribe && dshenv('DSH_DESKTOP_TRACE_BRIDGE', 'DSH_MAC_TRACE_BRIDGE') === '1') {
        const text = Buffer.concat(res._chunks).toString('utf8');
        console.error(`[host-trace] description -> ${JSON.stringify(text).slice(0, 800)}`);
      }
      resumeFetch(msg.id);
    },
  });
  const body =
    msg.body === undefined || msg.body === null || msg.body === ''
      ? null
      : Buffer.isBuffer(msg.body)
        ? msg.body
        : Buffer.from(msg.body, 'base64');
  const headers = sanitizeHeaders(msg.headers);
  // dsh >= 0.1.2-rc.1: /api/* routes sit behind BrowserAuth — a launch-token
  // query on `/` mints an authority-bound session cookie, and unauthenticated
  // requests get 401. The desktop WebView loads the static index directly and
  // never performs that exchange, so the bridge performs it server-side via
  // the official authorizeIndex path and injects the cookie into bridged
  // requests (per Host authority, minted lazily).
  if (bridgeBrowserAuth && !headers.cookie) {
    const cookie = ensureBridgeAuthCookie(headers.host);
    if (cookie) headers.cookie = cookie;
  }
  const req = createMockRequest({
    url,
    method: msg.method ?? 'GET',
    headers,
    body,
  });
  pendingFetches.set(msg.id, { req, res, sentEnd: false });
  if (dshenv('DSH_DESKTOP_TRACE_BRIDGE', 'DSH_MAC_TRACE_BRIDGE') === '1') {
    console.error(`[host-trace] fetch ${msg.method} ${url.slice(0, 120)} host=${msg.headers?.host} origin=${msg.headers?.origin}`);
  }
  (async () => {
    try {
      const route = routeFor(url);
      if (route === undefined) {
        res.writeHead(404);
        res.end('not found');
      } else {
        await dispatchRoute(route, req, res);
      }
    } catch (error) {
      console.error(`[host] fetch ${msg.method} ${msg.url} failed:`, error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(`handler failure: ${String(error)}`);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
    resumeFetch(msg.id);
  })();
}

function handleFetchAbort(msg) {
  const key = msg.key ?? msg.id;
  const pending = pendingFetches.get(key);
  if (pending === undefined) return;
  pending.res.destroy();
  pending.req.destroy();
  resumeFetch(key);
}

// ---------------------------------------------------------------------------
// WebSocket sessions
// ---------------------------------------------------------------------------
const wsSessions = new Map();

function sendWsFrame(streamId, data) {
  if (typeof data === 'string') {
    frame({ type: 'ws-frame', streamId, data });
  } else {
    frame({
      type: 'ws-frame',
      streamId,
      data: { base64: Buffer.from(data).toString('base64'), binary: true },
    });
  }
}

function sendWsClosed(streamId, code, reason) {
  frame({ type: 'ws-frame', streamId, closed: true, code: code ?? 1006, reason: reason ?? '' });
}

function openGenericWs(msg, path) {
  let parsed;
  try {
    parsed = new URL(path, 'http://dsh.internal');
  } catch {
    return { ok: false, reason: 'bad stream path' };
  }
  const route = webServer.matchUpgrade(parsed.pathname);
  if (route === undefined) return { ok: false, reason: `unknown stream ${parsed.pathname}` };
  if (wsSessions.has(msg.streamId)) return { ok: false, reason: 'duplicate stream id' };

  const decoder = new ServerFrameDecoder();
  const session = { decoder, closed: false };
  let handshaken = false;
  const socket = createMockSocket({
    onWrite(buffer) {
      decoder.push(buffer);
      if (!handshaken) {
        if (!decoder.consumeHandshake()) return;
        handshaken = true;
      }
      for (const ev of decoder.drain()) {
        if (ev.type === 'message') {
          const data =
            ev.opcode === OP_TEXT
              ? ev.data.toString('utf8')
              : ev.data.buffer.slice(ev.data.byteOffset, ev.data.byteOffset + ev.data.byteLength);
          sendWsFrame(msg.streamId, data);
        } else if (ev.type === 'ping') {
          socket.feed(encodeClientFrame(ev.data, OP_PONG));
        } else if (ev.type === 'close') {
          session.closed = true;
          wsSessions.delete(msg.streamId);
          socket.destroy();
          sendWsClosed(msg.streamId, ev.code, ev.reason);
        }
      }
    },
  });
  session.socket = socket;

  const wsHeaders = {
    host: '127.0.0.1',
    origin: 'http://127.0.0.1',
    upgrade: 'websocket',
    connection: 'Upgrade',
    'sec-websocket-key': randomBytes(16).toString('base64'),
    'sec-websocket-version': '13',
  };
  // dsh >= 0.1.2-rc.1: the gateway WS upgrade is BrowserAuth-fenced like the
  // /api routes — inject the bridge-minted session cookie or the handshake
  // gets a 401 rejection ("upgrade refused").
  const wsCookie = ensureBridgeAuthCookie(wsHeaders.host);
  if (wsCookie !== undefined) wsHeaders.cookie = wsCookie;
  const req = createMockRequest({
    url: path,
    method: 'GET',
    headers: wsHeaders,
    body: null,
  });
  try {
    route.handler(req, socket, Buffer.alloc(0));
  } catch (error) {
    socket.destroy();
    return { ok: false, reason: String(error?.message ?? error) };
  }
  if (handshaken === false || socket.destroyed || session.closed) {
    wsSessions.delete(msg.streamId);
    return { ok: false, reason: 'upgrade refused' };
  }
  wsSessions.set(msg.streamId, session);
  return { ok: true };
}

function handleWsOpen(msg) {
  if (msg.streamId === undefined || typeof msg.path !== 'string') {
    return { ok: false, reason: 'bad stream shape' };
  }
  return openGenericWs(msg, msg.path);
}

function handleWsClose(msg) {
  const session = wsSessions.get(msg.streamId);
  if (session !== undefined) {
    wsSessions.delete(msg.streamId);
    session.socket?.destroy();
  }
  return { ok: true };
}

function handleWsSend(msg) {
  const streamId = msg.streamId;
  const session = wsSessions.get(streamId);
  if (session === undefined || session.closed) return { ok: false, reason: 'unknown stream' };
  let buffer;
  let text = false;
  if (typeof msg.data === 'string') {
    buffer = Buffer.from(msg.data, 'utf8');
    text = true;
  } else if (typeof msg.data === 'object' && msg.data !== null && typeof msg.data.base64 === 'string') {
    buffer = Buffer.from(msg.data.base64, 'base64');
  } else {
    return { ok: false, reason: 'bad frame payload' };
  }
  if (buffer.byteLength > MAX_WS_SEND_BYTES) return { ok: false, reason: 'frame too large' };
  session.socket.feed(encodeClientFrame(buffer, text ? OP_TEXT : OP_BINARY));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// native notification toggles. The Rust shell persists them to
// notify-prefs.json beside the www dir and pushes live updates as
// set-notify-prefs bridge frames; a fresh boot replays the file.
// ---------------------------------------------------------------------------
const NOTIFY_TYPES = { turn_end: true, turn_failure: true, approval: true, error: true, plugin: true };
const NOTIFY_PREFS_PATH = () => join(dirname(WWW_DIR), 'notify-prefs.json');

function normalizeNotifyPrefs(input) {
  // Canonical shape: { enabled: boolean, <type>: boolean, ... } with a global
  // master switch. Tolerates the legacy { enabled: { <type>: boolean } } file.
  const out = { enabled: true };
  for (const key of Object.keys(NOTIFY_TYPES)) out[key] = NOTIFY_TYPES[key];
  if (input === null || typeof input !== 'object') return out;
  const legacy = input.enabled !== null && typeof input.enabled === 'object' ? input.enabled : null;
  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;
  for (const key of Object.keys(NOTIFY_TYPES)) {
    const value = legacy !== null ? legacy[key] : input[key];
    if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function loadNotifyPrefs() {
  try {
    return normalizeNotifyPrefs(JSON.parse(readFileSync(NOTIFY_PREFS_PATH(), 'utf8')));
  } catch {
    return normalizeNotifyPrefs(null);
  }
}

let notifyPrefs = loadNotifyPrefs();

// ---------------------------------------------------------------------------
// native notifications (window-visible filtering happens on the Rust side)
// ---------------------------------------------------------------------------
function installNotificationPumps() {
  const short = (id) => String(id).slice(0, 8);
  const disposers = [];

  // Live per-session events from the durable log. The host emits each appended
  // event with (session, event); the same channel drives the client transport.
  // Turn tracking mirrors the reference desktop plugin: only user-initiated
  // turns that actually complete (or fail) raise a notification, so agent
  // follow-up turns and streaming noise stay quiet.
  const openTurns = new Map();
  const keyOf = (session) => {
    const id = session?.id ?? session?.header?.id;
    return id === undefined ? undefined : String(id);
  };
  const subagentOf = (session) => session?.header?.origin === 'subagent';

  disposers.push(ctx.on('session/event', (session, event) => {
    if (event === undefined) return;
    const sid = keyOf(session);
    switch (event.type) {
      case 'approval/asked': {
        if (!(notifyPrefs.enabled && notifyPrefs.approval)) break;
        const toolName = event.data?.toolName;
        frame({
          type: 'notify',
          title: '需要审批',
          body: toolName ? `工具 ${toolName} 请求执行权限` : '有工具请求执行权限',
          backgroundOnly: false,
        });
        break;
      }
      case 'turn/start': {
        if (sid !== undefined) openTurns.set(sid, { turn: event.data?.turn, userInitiated: false });
        break;
      }
      case 'user/message': {
        const openTurn = sid === undefined ? undefined : openTurns.get(sid);
        if (openTurn !== undefined && event.data?.source?.kind === 'user') openTurn.userInitiated = true;
        break;
      }
      case 'turn/end': {
        if (sid === undefined) break;
        const openTurn = openTurns.get(sid);
        openTurns.delete(sid);
        if (openTurn === undefined || openTurn.turn !== event.data?.turn || !openTurn.userInitiated || subagentOf(session)) break;
        const reason = event.data?.reason?.kind;
        if (reason === 'completed' && notifyPrefs.enabled && notifyPrefs.turn_end) {
          frame({ type: 'notify', title: '完成对话', body: `会话 ${short(sid)} 的回复已就绪`, backgroundOnly: false });
        } else if ((reason === 'error' || reason === 'max-tokens') && notifyPrefs.enabled && notifyPrefs.turn_failure) {
          frame({ type: 'notify', title: '会话失败', body: `会话 ${short(sid)} 回复出错，请查看对话确认`, backgroundOnly: false });
        }
        break;
      }
      default:
        break;
    }
  }, { global: true }));

  // Forget half-open turn markers when a session goes away.
  disposers.push(ctx.on('session/disposed', (session) => {
    const sid = keyOf(session);
    if (sid !== undefined) openTurns.delete(sid);
  }, { global: true }));

  // Transport-level session errors (the session controller re-emits agent
  // errors with a stable message string).
  disposers.push(ctx.on('api-session/error', (sessionId, message) => {
    if (!(notifyPrefs.enabled && notifyPrefs.error)) return;
    frame({
      type: 'notify',
      title: '会话错误',
      body: String(message ?? '未知错误'),
      backgroundOnly: false,
    });
  }, { global: true }));

  // Dynamic Cordis plugin run requests need in-app approval.
  disposers.push(ctx.on('cordis/request-run', (payload) => {
    if (!(notifyPrefs.enabled && notifyPrefs.plugin)) return;
    const name = payload?.name;
    frame({
      type: 'notify',
      title: '插件等待批准',
      body: name ? `插件 ${name} 请求运行，请在应用中批准或拒绝` : '动态 Cordis 插件请求运行，请在应用中批准或拒绝',
      backgroundOnly: false,
    });
  }, { global: true }));

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
  };
}

// ---------------------------------------------------------------------------
// NDJSON control loop
// ---------------------------------------------------------------------------
let ctx = null;
let notificationDispose = null;
let exiting = false;

function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
  switch (msg.type) {
    case 'ping':
      frame({ type: 'pong', id: msg.id });
      return;
    case 'fetch':
      handleFetch(msg);
      return;
    case 'fetch-abort':
      handleFetchAbort(msg);
      return;
    case 'ws-open': {
      const result = handleWsOpen(msg);
      if (dshenv('DSH_DESKTOP_TRACE_BRIDGE', 'DSH_MAC_TRACE_BRIDGE') === '1') {
        console.error(`[host-trace] ws-open ${msg.path} -> ${result.ok ? 'OK' : `REFUSED: ${result.reason}`}`);
      }
      frame({ type: 'ws-result', id: msg.id, ok: result.ok === true, reason: result.reason ?? '' });
      return;
    }
    case 'ws-send': {
      const result = handleWsSend(msg);
      frame({ type: 'ws-send-result', id: msg.id, ok: result.ok === true, reason: result.reason ?? '' });
      return;
    }
    case 'ws-close': {
      handleWsClose(msg);
      frame({ type: 'ws-close-result', id: msg.id, ok: true });
      return;
    }
    case 'set-notify-prefs': {
      notifyPrefs = normalizeNotifyPrefs(msg.prefs);
      return;
    }
    default:
      console.error(`[host] unknown bridge message: ${msg.type}`);
  }
}

async function main() {
  try {
    statusFrame('boot', 'loading profile');
    ctx = await bootHost();
    statusFrame('boot', 'profile ready');
  } catch (error) {
    console.error('[host] boot failed:', error);
    statusFrame('failed', String(error?.stack ?? error));
    frame({ type: 'ready', ok: false, error: String(error?.stack ?? error) });
    return;
  }

  try {
    const clientModules = ctx.get('clientModules');
    if (clientModules === undefined) throw new Error('client-modules row not mounted');
    statusFrame('site', 'materializing www');
    const site = prepareSite({ webServer, clientModules, wwwDir: WWW_DIR });
    notificationDispose = installNotificationPumps();
    statusFrame('ready', 'host ready');
    frame({
      type: 'ready',
      ok: true,
      www: WWW_DIR,
      index: site.indexPath,
      home: resolveDshHome(),
      profile: resolveDshHome() ? `${resolveDshHome()}/profiles/${NAME}` : null,
      pid: process.pid,
    });
    console.error(`[host] portless bridge ready (profile=${NAME}, www=${WWW_DIR})`);
  } catch (error) {
    console.error('[host] site preparation failed:', error);
    statusFrame('failed', String(error?.stack ?? error));
    frame({ type: 'ready', ok: false, error: String(error?.stack ?? error) });
    return;
  }

  // ── framed stdin parser ──────────────────────────────────────────────
  // The Rust shell writes one JSON header line per message; a header that
  // carries `bodyLen` is followed by exactly `bodyLen` raw bytes (request
  // chunk-bin), so large upload bodies never cross the bridge as base64.
  // A force-killed shell surfaces as EOF (`end`/`close`), which shuts the
  // host down exactly like the previous readline loop did.
  let pending = null;
  // Buffered stdin bytes as a chunk list: bodies can reach the 128 MB limit,
  // so repeatedly concatenating the whole remainder per chunk would be O(n²).
  // We only spell bytes out of the front exactly once per message.
  let chunks = [];
  let chunkLen = 0;
  function append(data) {
    chunks.push(data);
    chunkLen += data.byteLength;
  }
  function take(n) {
    if (chunkLen < n) return null;
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const c = chunks[0];
      const takeNow = Math.min(c.byteLength, n - filled);
      c.copy(out, filled, 0, takeNow);
      filled += takeNow;
      if (takeNow === c.byteLength) chunks.shift();
      else chunks[0] = c.subarray(takeNow);
    }
    chunkLen -= n;
    return out;
  }
  function takeLine() {
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      const idx = chunks[i].indexOf(0x0a);
      if (idx !== -1) {
        const line = take(offset + idx).toString('utf8');
        take(1); // consume the newline
        return line;
      }
      offset += chunks[i].byteLength;
    }
    return null;
  }
  function pump() {
    for (;;) {
      if (pending === null) {
        const line = takeLine();
        if (line === null) break;
        if (line.trim() === '') continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          console.error(`[host] bad bridge frame: ${line.slice(0, 200)}`);
          continue;
        }
        const bodyLen = msg.bodyLen;
        if (typeof bodyLen === 'number' && bodyLen > 0) {
          pending = { msg, body: Buffer.allocUnsafe(bodyLen), filled: 0 };
        } else {
          handleMessage(msg);
        }
      } else {
        const need = pending.msg.bodyLen - pending.filled;
        const piece = take(need);
        if (piece === null) break;
        piece.copy(pending.body, pending.filled);
        pending.filled += piece.byteLength;
        if (pending.filled === pending.msg.bodyLen) {
          const { msg, body } = pending;
          pending = null;
          msg.body = body;
          delete msg.bodyLen;
          handleMessage(msg);
        }
      }
    }
  }
  process.stdin.on('data', (chunk) => {
    append(chunk);
    pump();
  });
  process.stdin.on('close', () => void shutdown('bridge stdin closed'));
}

async function shutdown(reason) {
  if (exiting) return;
  exiting = true;
  console.error(`[host] ${reason}; disposing host`);
  try {
    notificationDispose?.();
  } catch {
    /* ignore */
  }
  try {
    await ctx?.fiber.dispose();
  } catch (error) {
    console.error('[host] dispose error:', error);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  console.error('[host] uncaught exception:', error);
  frame({ type: 'exit', code: 1, term: 'uncaughtException' });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[host] unhandled rejection:', error);
});

// If the Rust shell is force-killed (SIGKILL), our stdin hits EOF. Never
// outlive the shell — shut down even while boot is still in progress.
// resume() lets EOF surface before the readline loop attaches.
process.stdin.resume();
process.stdin.on('end', () => void shutdown('bridge stdin closed'));

await main();