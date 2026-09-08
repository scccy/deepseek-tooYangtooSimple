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
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format } from 'node:util';

import { createIpcWebServer } from './ipc-web-server.mjs';
import { createDesktopPnpmService, createDesktopProfilesService } from './desktop-pnpm.mjs';
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
const ABOUT_BUNDLE_REVISION = 5;
const ABOUT_CLIENT_TEMPLATE = (versionJson) => `window.__ModuleLoader__.load({
  id: ${JSON.stringify(ABOUT_PACKAGE)},
  factory: (require) => {
    let react = require("react");
    var module = { exports: {} };
    var exports = module.exports;
    var VERSION = ${versionJson};
    var inject = ["slots"];
    var rowStyle = {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "16px 0",
      borderBottom: "1px solid var(--dsw-alias-border-l2)"
    };
    var titleStyle = {
      color: "var(--dsw-alias-label-primary)",
      fontSize: "14px",
      lineHeight: "22px"
    };
    var valueStyle = {
      color: "var(--dsw-alias-label-secondary)",
      fontVariantNumeric: "tabular-nums",
      fontSize: "14px",
      lineHeight: "22px"
    };
    var textWrapStyle = {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minWidth: 0,
      paddingRight: "16px"
    };
    var hintStyle = {
      color: "var(--dsw-alias-label-secondary)",
      fontSize: "12px",
      lineHeight: "18px",
      whiteSpace: "pre-wrap"
    };
    var buttonBaseStyle = {
      flexShrink: 0,
      marginLeft: "16px",
      padding: "5px 14px",
      borderRadius: "8px",
      border: "1px solid var(--dsw-alias-border-l2)",
      background: "var(--dsw-alias-bg-layer-2)",
      color: "var(--dsw-alias-label-primary)",
      fontSize: "13px",
      lineHeight: "20px"
    };
    function buttonStyle(busy) {
      return Object.assign({}, buttonBaseStyle, {
        cursor: busy ? "progress" : "pointer",
        opacity: busy ? 0.55 : 1
      });
    }
    function invokeNative(cmd, args) {
      var api = window.__TAURI__;
      if (api === undefined || api.core === undefined || typeof api.core.invoke !== "function") {
        return Promise.reject(new Error("desktop bridge unavailable"));
      }
      return api.core.invoke(cmd, args || {});
    }
    function listenNative(event, handler) {
      var api = window.__TAURI__;
      if (api !== undefined && api.event !== undefined && typeof api.event.listen === "function") {
        return api.event.listen(event, handler);
      }
      return Promise.resolve(function () {});
    }
    function VersionRow() {
      return react.createElement("div", { style: rowStyle },
        react.createElement("div", { style: titleStyle }, "桌面版版本 / Desktop version"),
        react.createElement("div", { style: valueStyle }, "v" + VERSION)
      );
    }
    function DshUpdateRow() {
      var infoState = react.useState(null);
      var info = infoState[0];
      var setInfo = infoState[1];
      var checkingState = react.useState(false);
      var checking = checkingState[0];
      var setChecking = checkingState[1];
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var tailState = react.useState([]);
      var tail = tailState[0];
      var setTail = tailState[1];
      var statusState = react.useState("");
      var status = statusState[0];
      var setStatus = statusState[1];

      function refresh(force) {
        if (checking) return;
        setChecking(true);
        invokeNative("shell_check_update", { force: force === true }).then(function (result) {
          setInfo(result && typeof result === "object" ? result : {});
        }, function (error) {
          setInfo({ error: error && error.message ? error.message : String(error) });
        }).finally(function () {
          setChecking(false);
        });
      }
      react.useEffect(function () {
        refresh(false);
      }, []);

      react.useEffect(function () {
        var unlisten = null;
        var active = true;
        listenNative("dsh:update-progress", function (event) {
          if (!active) return;
          var payload = event && event.payload ? event.payload : {};
          if (payload.phase === "done") {
            setBusy(false);
            setStatus(payload.line ? String(payload.line) : "更新完成");
          } else if (payload.phase === "error") {
            setBusy(false);
            setStatus("失败：" + (payload.line ? String(payload.line) : "未知错误"));
          } else {
            setBusy(true);
            if (payload.line) {
              var line = String(payload.line);
              setTail(function (prev) {
                var next = prev.concat([line]);
                if (next.length > 4) next = next.slice(next.length - 4);
                return next;
              });
            }
          }
        }).then(function (fn) {
          unlisten = fn;
          if (!active && typeof fn === "function") fn();
        });
        return function () {
          active = false;
          if (unlisten && typeof unlisten === "function") unlisten();
        };
      }, []);

      function onUpdate() {
        if (busy) return;
        setBusy(true);
        setStatus("");
        setTail([]);
        invokeNative("shell_dsh_update").then(function () {
          // progress arrives via dsh:update-progress; the host then restarts.
        }, function (error) {
          setBusy(false);
          setStatus("失败：" + (error && error.message ? error.message : String(error)));
        });
      }

      var localLabel = info && info.localVersion ? "v" + info.localVersion : (checking ? "检测中…" : "未读取");
      var latestLabel = info && info.latestVersion ? "v" + info.latestVersion : "—";
      var versionStatus = "";
      if (info && info.error) {
        versionStatus = String(info.error);
      } else if (info && info.updateAvailable) {
        versionStatus = "发现新版本，可更新";
      } else if (info && info.localVersion && info.latestVersion) {
        versionStatus = "已是最新";
      }
      var versionLine = "本地 " + localLabel;
      if (info && info.latestVersion) {
        versionLine = versionLine + " · 仓库 " + latestLabel;
      }
      if (versionStatus) {
        versionLine = versionLine + " · " + versionStatus;
      }

      var actionLine = status;
      if (!actionLine && tail.length > 0) {
        actionLine = tail.join(" · ");
      }

      var buttonsStyle = {
        flexShrink: 0,
        marginLeft: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        alignItems: "stretch"
      };
      return react.createElement("div", { style: Object.assign({}, rowStyle, { alignItems: "flex-start" }) },
        react.createElement("div", { style: textWrapStyle },
          react.createElement("div", { style: titleStyle }, "dsh 版本与更新 / DSH version & update"),
          react.createElement("div", { style: hintStyle }, versionLine),
          actionLine ? react.createElement("div", { style: hintStyle }, actionLine) : null
        ),
        react.createElement("div", { style: buttonsStyle },
          react.createElement("button", {
            style: buttonStyle(busy),
            disabled: busy,
            onClick: onUpdate
          }, busy ? "更新中…" : "更新 dsh"),
          react.createElement("button", {
            style: buttonStyle(checking),
            disabled: checking,
            onClick: function () { refresh(true); }
          }, checking ? "检测中…" : "检测更新")
        )
      );
    }
    function HotRestartRow() {
      var busyState = react.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var messageState = react.useState("");
      var message = messageState[0];
      var setMessage = messageState[1];
      function onHotRestart() {
        if (busy) return;
        setBusy(true);
        setMessage("正在请求热重启…");
        invokeNative("shell_hot_restart").then(function () {
          setMessage("主机正在重启，页面将在准备好后自动重载。");
        }, function (error) {
          setBusy(false);
          setMessage("热重启失败：" + (error && error.message ? error.message : String(error)));
        });
      }
      return react.createElement("div", { style: Object.assign({}, rowStyle, { alignItems: "flex-start" }) },
        react.createElement("div", { style: textWrapStyle },
          react.createElement("div", { style: titleStyle }, "热重启 / Hot restart"),
          react.createElement("div", { style: hintStyle }, message.length > 0 ? message : "不移动、不关闭窗口：重启本机主机进程并重新加载界面；进行中的会话会结束。")
        ),
        react.createElement("button", {
          style: buttonStyle(busy),
          disabled: busy,
          onClick: onHotRestart
        }, busy ? "重启中…" : "立即重启")
      );
    }
    function apply(ctx) {
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "desktop-version",
        order: 900
      }, VersionRow));
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "desktop-dsh-update",
        order: 910
      }, DshUpdateRow));
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "desktop-hot-restart",
        order: 950
      }, HotRestartRow));
    }
    exports.apply = apply;
    exports.inject = inject;
    exports.name = ${JSON.stringify(ABOUT_PACKAGE)};
    return module.exports;
  }
});
`;

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
  writeFileSync(clientPath, ABOUT_CLIENT_TEMPLATE(JSON.stringify(ABOUT_VERSION)), 'utf8');
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

const MUX_EVENTS_PATH = '/api/events.mux';
const HOST_EVENTS_PATH = '/api/events.host';
const MAX_WS_SEND_BYTES = 1 << 20;

// Keep stdout clean: the parent Rust shell treats stdout as NDJSON only.
for (const key of ['log', 'info', 'warn', 'error', 'debug']) {
  const fn = console[key].bind(console);
  console[key] = (...args) => process.stderr.write(`${format(...args)}\n`);
}

function frame(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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

function serverRequest(framePayload) {
  return {
    type: 'server-request',
    rpcId: framePayload.rpcId,
    method: framePayload.payload.type,
    payload: framePayload.payload,
  };
}

function failureFrame(error) {
  return {
    rpcId: randomUUID(),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  };
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
  const listeners = new Map();
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
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return res;
    },
    once(event, fn) {
      const wrapped = (...args) => {
        res.off(event, wrapped);
        fn(...args);
      };
      return res.on(event, wrapped);
    },
    off(event, fn) {
      listeners.get(event)?.delete(fn);
      return res;
    },
    removeAllListeners(event) {
      if (event === undefined) listeners.clear();
      else listeners.delete(event);
      return res;
    },
    _emit(event, ...args) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
    destroy() {
      if (res.writableEnded || res.destroyed) return;
      res.destroyed = true;
      res._emit('close');
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
      : Buffer.from(msg.body, 'base64');
  const req = createMockRequest({
    url,
    method: msg.method ?? 'GET',
    headers: sanitizeHeaders(msg.headers),
    body,
  });
  pendingFetches.set(msg.id, { req, res, sentEnd: false });
  if (dshenv('DSH_DESKTOP_TRACE_BRIDGE', 'DSH_MAC_TRACE_BRIDGE') === '1') {
    console.error(`[host-trace] fetch ${msg.method} ${url}`);
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
const wsPumps = new Map();
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

function openEventsPump(msg, path) {
  const apiProxy = ctx.get('apiProxy');
  if (apiProxy === undefined) return { ok: false, reason: 'no api gateway' };
  if (wsPumps.has(msg.streamId)) return { ok: false, reason: 'duplicate stream id' };
  const abort = new AbortController();
  wsPumps.set(msg.streamId, abort);
  const open =
    path === MUX_EVENTS_PATH
      ? (signal) => apiProxy.events.mux({ rpcId: randomUUID(), payload: {} }, signal)
      : (signal) => apiProxy.events.host({ rpcId: randomUUID(), payload: {} }, signal);
  (async () => {
    try {
      for await (const item of open(abort.signal)) {
        sendWsFrame(msg.streamId, JSON.stringify(serverRequest(item)));
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        sendWsFrame(msg.streamId, JSON.stringify(failureFrame(error)));
      }
    } finally {
      wsPumps.delete(msg.streamId);
    }
  })();
  return { ok: true };
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

  const req = createMockRequest({
    url: path,
    method: 'GET',
    headers: {
      host: '127.0.0.1',
      origin: 'http://127.0.0.1',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': randomBytes(16).toString('base64'),
      'sec-websocket-version': '13',
    },
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
  if (msg.path === MUX_EVENTS_PATH || msg.path === HOST_EVENTS_PATH) {
    return openEventsPump(msg, msg.path);
  }
  return openGenericWs(msg, msg.path);
}

function handleWsClose(msg) {
  const abort = wsPumps.get(msg.streamId);
  if (abort !== undefined) {
    abort.abort();
    wsPumps.delete(msg.streamId);
  }
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
// native notifications (window-visible filtering happens on the Rust side)
// ---------------------------------------------------------------------------
function installNotificationPumps() {
  const apiProxy = ctx.get('apiProxy');
  if (apiProxy === undefined) return;
  const abort = new AbortController();
  const subagentSessions = new Set();
  const short = (id) => String(id).slice(0, 8);
  const pump = async (stream, onFrame) => {
    try {
      for await (const item of stream({ rpcId: randomUUID(), payload: {} }, abort.signal)) {
        onFrame(item.payload);
      }
    } catch (error) {
      if (!abort.signal.aborted) console.error('[host] notification stream ended:', error);
    }
  };
  void pump(apiProxy.events.mux, (payload) => {
    switch (payload.type) {
      case 'approval/requested':
        frame({ type: 'notify', title: '需要审批', body: `工具 ${payload.toolName} 请求执行权限`, backgroundOnly: false });
        break;
      case 'question/requested': {
        const first = payload.questions?.[0];
        if (first !== undefined) {
          frame({ type: 'notify', title: '等待回答', body: first.question, backgroundOnly: false });
        }
        break;
      }
      case 'session/event':
        if (payload.event?.type === 'turn/end' && !subagentSessions.has(payload.sessionId)) {
          frame({ type: 'notify', title: '完成对话', body: `会话 ${short(payload.sessionId)} 的回复已就绪`, backgroundOnly: true });
        }
        break;
      default:
        break;
    }
  });
  void pump(apiProxy.events.host, (payload) => {
    switch (payload.type) {
      case 'host/session-added':
        if (payload.origin === 'subagent') subagentSessions.add(payload.sessionId);
        break;
      case 'host/session-removed':
        subagentSessions.delete(payload.sessionId);
        break;
      case 'host/agent-error':
        frame({ type: 'notify', title: '会话错误', body: payload.message, backgroundOnly: false });
        break;
      case 'host/remote-event':
        if (payload.event === 'cordis/request-run') {
          frame({ type: 'notify', title: '插件等待批准', body: '动态 Cordis 插件请求运行，请在应用中批准或拒绝', backgroundOnly: false });
        }
        break;
      default:
        break;
    }
  });
  return () => abort.abort();
}

// ---------------------------------------------------------------------------
// NDJSON control loop
// ---------------------------------------------------------------------------
let ctx = null;
let notificationDispose = null;

function handleMessage(line) {
  if (line.trim() === '') return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`[host] bad bridge frame: ${line.slice(0, 200)}`);
    return;
  }
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
    default:
      console.error(`[host] unknown bridge message: ${msg.type}`);
  }
}

async function main() {
  try {
    ctx = await bootHost();
  } catch (error) {
    console.error('[host] boot failed:', error);
    frame({ type: 'ready', ok: false, error: String(error?.stack ?? error) });
    return;
  }

  try {
    const clientModules = ctx.get('clientModules');
    if (clientModules === undefined) throw new Error('client-modules row not mounted');
    const site = prepareSite({ webServer, clientModules, wwwDir: WWW_DIR });
    notificationDispose = installNotificationPumps();
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
    frame({ type: 'ready', ok: false, error: String(error?.stack ?? error) });
    return;
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', handleMessage);
  lines.on('close', () => void shutdown('bridge stdin closed'));
}

async function shutdown(reason) {
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