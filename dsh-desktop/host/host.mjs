/**
 * dsh-desktop host (official-style carrier).
 *
 * Boots the `desktop` profile through the official `runProfile` with the REAL
 * webserver row bound to 127.0.0.1:19387 (+ BrowserAuth token). The webview
 * loads the authenticated loopback URL directly — HTTP/WebSocket travel over
 * the kernel loopback stack, so there is no portless bridge and no
 * fetch/WS interception anywhere.
 *
 * stdout is the NDJSON control plane only (status/ready/notify/
 * credential-state/quit-result/welcome replies); every human log goes to
 * stderr (the Rust shell forwards them to the app log file).
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { format } from 'node:util';

import { createDesktopPnpmService, createDesktopProfilesService } from './desktop-pnpm.mjs';
import { renderAboutClient } from './desktop-about-template.mjs';

// Cross-platform env read: DSH_DESKTOP_* wins, DSH_MAC_* kept for legacy.
const dshenv = (name, legacy) => process.env[name] ?? process.env[legacy];

// ---------------------------------------------------------------------------
// package resolution: all dsh packages resolve from the installed dsh root.
// ---------------------------------------------------------------------------
const DSH_ROOT = (() => {
  // The Rust shell always injects DSH_DESKTOP_DSH_ROOT (it resolves the user's
  // global install and fails fast otherwise); the env/flag fallbacks exist
  // for running the host standalone during development.
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

const [{ runProfile, initializeProfileFromDefault }, { loadLayeredEnv }, { resolveDshHome }] = await Promise.all([
  importPackage('@deepseek-ai/dsh/profile-boot'),
  importPackage('@deepseek-ai/dsh-app-boot'),
  importPackage('@deepseek-ai/dsh-home-paths'),
]);

// Ride the user's shared `web` profile: plugins installed via the CLI (or the
// app) live in ONE profile, so the desktop and `dsh web` always see the same
// set. All desktop-surface UI (account launcher, settings sections) keys on
// the injected `dshDesktop` global, not on the profile name; the only
// name-gated row we want (sidebar browser tabs) is re-enabled in the overlay.
// Override with DSH_DESKTOP_PROFILE for an isolated profile (e.g. `desktop`).
const NAME = (dshenv('DSH_DESKTOP_PROFILE', 'DSH_MAC_PROFILE') ?? 'web').trim() || 'web';
// Same port as the official desktop (Electron loads http://127.0.0.1:19387).
const PORT = (dshenv('DSH_DESKTOP_PORT', 'DSH_MAC_PORT') ?? '19387').trim() || '19387';
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';
// Only used to locate notify-prefs.json (kept beside the legacy www dir).
const WWW_DIR = dshenv('DSH_DESKTOP_WWW_DIR', 'DSH_MAC_WWW_DIR') ?? join(resolveDshHome(), 'desktop-www');

// The desktop rows in the web settings panel ship as a tiny client-only
// bundle, materialized into the active profile's node_modules at boot so the
// official client-modules graph picks it up like any other web plugin. The
// app version travels from the Rust shell (DSH_DESKTOP_APP_VERSION); the extra
// bundle revision forces a refresh when the generated client code changes
// without an app version bump.
const ABOUT_PACKAGE = '@dsh-desktop/desktop-about';
const ABOUT_VERSION = (dshenv('DSH_DESKTOP_APP_VERSION', 'DSH_MAC_APP_VERSION') ?? '0.0.0').trim() || '0.0.0';
const ABOUT_BUNDLE_REVISION = 16;

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

/**
 * The `--patch` overlay for the desktop profile: re-enables nothing that the
 * web template already enables (the webserver row stays up — it IS the app
 * origin now), keeps the HMR rows off for a packaged app, and inserts the
 * desktop-about client bundle.
 */
function writeOverlayPatch() {
  const overlayPath = join(resolveDshHome(), 'desktop-host.overlay.yml');
  writeFileSync(overlayPath, `${[
    '# dsh-desktop host overlay (rewritten each boot)',
    '- insert:',
    '    - id: desktop-version',
    `      name: ${JSON.stringify(ABOUT_PACKAGE)}`,
    '- id: hmr',
    '  disabled: true',
    '- id: client-hmr',
    '  disabled: true',
    '# The shell boots with DSH_TELEMETRY_DISABLED=1; the desktop-gated',
    '# telemetry/analytics rows would otherwise demand official-build envs.',
    '- id: desktop-product-telemetry',
    '  disabled: true',
    '- id: product-analytics',
    '  disabled: true',
    '# Sidebar browser tabs are gated on profileContext.name === "desktop";',
    '# the shared web profile rides under the `web` name, so re-enable here.',
    '- id: ui-sidebar-browser',
    '  disabled: false',
    '',
  ].join('\n')}`, 'utf8');
  return overlayPath;
}

// Keep stdout clean: the Rust shell treats stdout as NDJSON only.
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

// ---------------------------------------------------------------------------
// notification prefs (window-visible filtering happens on the Rust side)
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
/** Credential-shaped API failure: 401/403 or credential/authz keywords. */
function isCredentialError(message) {
  const text = String(message ?? '');
  if (/\b40[13]\b/.test(text)) return true;
  const lowered = text.toLowerCase();
  return ['credential', 'unauthorized', 'forbidden', 'api key', 'apikey', 'authentication']
    .some((needle) => lowered.includes(needle));
}

function installNotificationPumps(ctx) {
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
  // errors with a stable message string). Credential-shaped failures are
  // additionally reported to the shell so the workspace can surface an
  // expiry banner (batch 2 credential-expiry detection).
  disposers.push(ctx.on('api-session/error', (sessionId, message) => {
    const text = String(message ?? '');
    if (isCredentialError(text)) {
      // Unconditional on purpose: an expired credential is actionable even
      // when the user silenced error notifications.
      frame({ type: 'credential-state', state: 'expired', detail: text.slice(0, 200) });
    }
    if (!(notifyPrefs.enabled && notifyPrefs.error)) return;
    frame({
      type: 'notify',
      title: '会话错误',
      body: text || '未知错误',
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
let shutdownHandle = null;
let notificationDispose = null;
let exiting = false;

// ---------------------------------------------------------------------------
// quit-inspection (ported from official desktop-host/src/quit-inspection.ts)
// ---------------------------------------------------------------------------
// Answers two facts before the shell quits:
//   ① runningTasks         — live agents (incl. subagents / approval waits /
//                            queued inbox) plus running|stopping jobs;
//   ② scheduledReminders   — `schedule` family entries reported by the
//                            `workspace/session-activity` waterfall for any
//                            loaded session.
// Any true → the shell shows a "confirm quit" dialog. On failure or timeout
// with the Host booted, we answer ready=true + runningTasks=true (better a
// spurious dialog than a silent exit). Hard frame deadline: 2s.
const QUIT_FRAME_DEADLINE_MS = 1800;
const QUIT_SERVICE_TIMEOUT_MS = 200;
const QUIT_SCHEDULE_BUDGET_MS = 1200;
const QUIT_SCHEDULE_PROBE_TIMEOUT_MS = 300;

function quitAsArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`quit-inspection: ${label} returned unexpected shape`);
  return value;
}

function quitIsActiveAgent(agent) {
  return agent?.status === 'running'
    || (agent?.inbox?.nextTurn?.length ?? 0) > 0
    || (agent?.inbox?.nextStep?.length ?? 0) > 0;
}

function quitIsRunningJob(job) {
  return job?.status === 'running' || job?.status === 'stopping';
}

function quitService(name) {
  try {
    const viaGet = ctx.get?.(name);
    if (viaGet !== undefined) return viaGet;
  } catch {
    /* fall through to direct property access */
  }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/** Race `promise` against a timer; the loser's rejection stays handled. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  timer.unref?.();
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One quit inspection pass. `hostReady` is captured by the caller before any
 * await, so "not ready" and "mid-check failure" stay distinguishable.
 * Failures inside the try are conservative (runningTasks=true); services
 * missing before the check starts are "not ready" (ready=false).
 */
async function performQuitInspection(hostReady) {
  const base = {
    ready: hostReady,
    runningTasks: false,
    scheduledReminders: false,
    details: { agents: 0, jobs: 0, reminders: 0 },
  };
  if (ctx === null) return { ...base, ready: false, notes: 'Host not booted' };
  if (exiting) {
    return { ...base, ready: true, runningTasks: true, notes: 'Host is stopping; assuming running tasks' };
  }
  const agents = quitService('agents');
  const jobs = quitService('jobs');
  if (agents === undefined || jobs === undefined) {
    const missing = [agents === undefined ? 'agents' : null, jobs === undefined ? 'jobs' : null]
      .filter(Boolean)
      .join(', ');
    return { ...base, ready: false, notes: `task services unavailable (${missing})` };
  }

  // From here the check is in progress: any failure falls through to the
  // conservative "assume running tasks" answer below.
  try {
    const liveAgents = await withTimeout(
      Promise.resolve(agents.list()).then((rows) => quitAsArray(rows, 'agents.list()')),
      QUIT_SERVICE_TIMEOUT_MS,
      'agents.list()',
    );
    const activeAgents = liveAgents.filter(quitIsActiveAgent);

    const jobRows = [
      await withTimeout(
        Promise.resolve(jobs.list()).then((rows) => quitAsArray(rows, 'jobs.list()')),
        QUIT_SERVICE_TIMEOUT_MS,
        'jobs.list()',
      ),
    ];
    for (const agent of liveAgents) {
      jobRows.push(
        await withTimeout(
          Promise.resolve(jobs.list(agent?.id)).then((rows) => quitAsArray(rows, 'jobs.list(agent)')),
          QUIT_SERVICE_TIMEOUT_MS,
          'jobs.list(agent)',
        ),
      );
    }
    const runningJobs = jobRows.flat().filter(quitIsRunningJob);
    const runningTasks = activeAgents.length > 0 || runningJobs.length > 0;

    // schedule probe: the `schedule` family of `workspace/session-activity`.
    // Only reminders of sessions loaded during this run can be armed.
    let scheduledReminders = false;
    let reminders = 0;
    let scheduleNote = '';
    if (typeof ctx.waterfall !== 'function') {
      scheduleNote = 'schedule capability absent (no ctx.waterfall)';
    } else {
      const deadlineAt = Date.now() + QUIT_SCHEDULE_BUDGET_MS;
      for (const agent of liveAgents) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          // Could not finish checking schedules: stay conservative.
          throw new Error('schedule probe budget exhausted');
        }
        const activity = await withTimeout(
          Promise.resolve(
            ctx.waterfall('workspace/session-activity', { sessionId: agent?.id }, () => Promise.resolve([])),
          ),
          Math.min(QUIT_SCHEDULE_PROBE_TIMEOUT_MS, remaining),
          'workspace/session-activity',
        );
        const entries = quitAsArray(activity, 'session-activity');
        reminders += entries.filter((entry) => entry?.kind === 'schedule').length;
        if (reminders > 0) {
          scheduledReminders = true;
          break;
        }
      }
    }

    return {
      ready: true,
      runningTasks,
      scheduledReminders,
      details: { agents: activeAgents.length, jobs: runningJobs.length, reminders },
      notes: scheduleNote === '' ? 'ok' : scheduleNote,
    };
  } catch (error) {
    const detail = error?.message ?? String(error);
    return {
      ...base,
      ready: true,
      runningTasks: true,
      notes: `quit-inspection failed: ${detail}; assuming running tasks`,
    };
  }
}

/**
 * Bridge frame handler: replies exactly one terminal `quit-result` frame —
 * either the computed answer or a conservative timeout fallback — within the
 * hard deadline, never throwing out of handleMessage.
 */
function handleQuitInspection(msg) {
  const id = msg.id;
  let replied = false;
  const reply = (payload) => {
    if (replied) return;
    replied = true;
    frame({ type: 'quit-result', id, ...payload });
  };
  const fallback = () => {
    if (ctx !== null && !exiting) {
      reply({
        ready: true,
        runningTasks: true,
        scheduledReminders: false,
        details: { agents: 0, jobs: 0, reminders: 0 },
        notes: `quit-inspection timed out after ${QUIT_FRAME_DEADLINE_MS}ms; assuming running tasks`,
      });
    } else {
      reply({
        ready: false,
        runningTasks: false,
        scheduledReminders: false,
        details: { agents: 0, jobs: 0, reminders: 0 },
        notes: 'Host not ready when quit-inspection timed out',
      });
    }
  };
  const guard = setTimeout(fallback, QUIT_FRAME_DEADLINE_MS);
  guard.unref?.();
  performQuitInspection(ctx !== null && !exiting)
    .then(reply, fallback)
    .finally(() => clearTimeout(guard));
}

// ---------------------------------------------------------------------------
// Welcome onboarding frames (batch 2): credentials + settings probes
// ---------------------------------------------------------------------------
// Three request frames used by the desktop shell's Welcome window:
//   credentials-describe / credentials-set → the `ctx.credentials` seam
//     (@deepseek-ai/dsh-credentials: describe()/set() over a CredentialRef);
//   settings-get → the `ctx.settings` service (SettingsForms.describe()),
//     reading dotted keys like `locale.preference` as `<namespace>.<field>`.
// All three follow the quit-inspection contract: exactly one terminal frame
// per request within a 2s hard deadline, conservative values when the Host is
// not booted or the service is missing, and nothing ever thrown out of
// handleMessage.
const WELCOME_FRAME_DEADLINE_MS = 2000;

// quit-inspection's ctx.get(name)/ctx[name] lookup pattern, reused verbatim.
const getService = quitService;

let credentialsModulePromise = null;
function loadCredentialsModule() {
  credentialsModulePromise ??= importPackage('@deepseek-ai/dsh-credentials');
  return credentialsModulePromise;
}

/**
 * Prefer the branded `credentialRef()` factory when the package exports it;
 * fall back to a plain string ref (typeof-checked at runtime) so the frames
 * keep working against builds without the named export.
 */
async function toCredentialRef(name) {
  try {
    const mod = await loadCredentialsModule();
    if (typeof mod?.credentialRef === 'function') return mod.credentialRef(name);
  } catch {
    /* package import failed: plain string ref below still works at runtime */
  }
  return name;
}

/**
 * Shared reply guard: exactly one terminal frame of `terminalType`, either
 * from `work` or from `fallback(detail)` on rejection/timeout.
 */
function welcomeGuard(msg, terminalType, fallback) {
  const id = msg.id;
  let replied = false;
  const reply = (payload) => {
    if (replied) return;
    replied = true;
    frame({ type: terminalType, id, ...payload });
  };
  const guard = setTimeout(() => reply(fallback(`timed out after ${WELCOME_FRAME_DEADLINE_MS}ms`)), WELCOME_FRAME_DEADLINE_MS);
  guard.unref?.();
  const settle = (work) =>
    Promise.resolve()
      .then(work)
      .then(reply, (error) => reply(fallback(error?.message ?? String(error))))
      .finally(() => clearTimeout(guard));
  return { reply, settle };
}

function handleCredentialsDescribe(msg) {
  const fallback = (detail) => ({
    configured: false,
    source: null,
    writable: false,
    notes: ctx === null
      ? `Host not booted; credentials service unavailable (${detail})`
      : `credentials describe failed; reporting unconfigured (${detail})`,
  });
  const g = welcomeGuard(msg, 'credentials-info', fallback);
  g.settle(async () => {
    if (ctx === null) return fallback('Host not booted');
    const credentials = getService('credentials');
    if (!credentials || typeof credentials.describe !== 'function') {
      return { configured: false, source: null, writable: false, notes: 'credentials service unavailable' };
    }
    const ref = await toCredentialRef(String(msg.ref ?? ''));
    const info = await withTimeout(
      Promise.resolve(credentials.describe(ref)),
      WELCOME_FRAME_DEADLINE_MS,
      'credentials.describe()',
    );
    return {
      configured: info?.configured === true,
      source: typeof info?.source === 'string' ? info.source : null,
      writable: info?.writable === true,
      notes: 'ok',
    };
  });
}

function handleCredentialsSet(msg) {
  const fallback = (detail) => ({ ok: false, error: `credentials-set ${detail}` });
  const g = welcomeGuard(msg, 'credentials-result', fallback);
  g.settle(async () => {
    // Rust side validates too; belt and braces.
    if (typeof msg.value !== 'string' || msg.value === '') {
      return { ok: false, error: 'value must be a non-empty string' };
    }
    if (ctx === null) return { ok: false, error: 'credentials service unavailable (Host not booted)' };
    const credentials = getService('credentials');
    if (!credentials || typeof credentials.set !== 'function') {
      return { ok: false, error: 'credentials service unavailable' };
    }
    const ref = await toCredentialRef(String(msg.ref ?? ''));
    await withTimeout(
      Promise.resolve(credentials.set(ref, msg.value)),
      WELCOME_FRAME_DEADLINE_MS,
      'credentials.set()',
    );
    // Read back describe() to confirm the write landed; the frame stays ok
    // even if the confirmation itself fails.
    try {
      const info = await withTimeout(
        Promise.resolve(credentials.describe(ref)),
        WELCOME_FRAME_DEADLINE_MS,
        'credentials.describe()',
      );
      return { ok: true, error: null, notes: `ok; configured=${info?.configured === true}` };
    } catch (error) {
      const detail = error?.message ?? String(error);
      return { ok: true, error: null, notes: `ok; configured state unknown (${detail})` };
    }
  });
}

function handleSettingsGet(msg) {
  const fallback = (detail) => ({ value: null, notes: `settings-get failed (${detail})` });
  const g = welcomeGuard(msg, 'settings-value', fallback);
  g.settle(async () => {
    const key = typeof msg.key === 'string' ? msg.key : '';
    if (key === '') return { value: null, notes: 'settings-get failed: missing key' };
    if (ctx === null) return { value: null, notes: 'Host not booted; settings service unavailable' };
    const settings = getService('settings');
    if (!settings || typeof settings.describe !== 'function') {
      return { value: null, notes: 'settings service unavailable' };
    }
    // Key grammar: `<namespace>.<field path…>`, e.g. `locale.preference`.
    const dot = key.indexOf('.');
    const ns = dot === -1 ? key : key.slice(0, dot);
    const path = dot === -1 ? [] : key.slice(dot + 1).split('.');
    const rows = await withTimeout(
      Promise.resolve(settings.describe()),
      WELCOME_FRAME_DEADLINE_MS,
      'settings.describe()',
    );
    if (!Array.isArray(rows)) return { value: null, notes: 'settings.describe() returned unexpected shape' };
    const row = rows.find((entry) => entry?.ns === ns);
    if (!row) return { value: null, notes: `settings namespace "${ns}" not found` };
    let current = row.value;
    for (const segment of path) {
      if (current === null || typeof current !== 'object') {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (current === undefined) return { value: null, notes: `key "${key}" not set` };
    return { value: current, notes: 'ok' };
  });
}

function handleMessage(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
  switch (msg.type) {
    case 'ping':
      frame({ type: 'pong', id: msg.id });
      return;
    case 'quit-inspection':
      handleQuitInspection(msg);
      return;
    case 'credentials-describe':
      handleCredentialsDescribe(msg);
      return;
    case 'credentials-set':
      handleCredentialsSet(msg);
      return;
    case 'settings-get':
      handleSettingsGet(msg);
      return;
    case 'set-notify-prefs': {
      notifyPrefs = normalizeNotifyPrefs(msg.prefs);
      return;
    }
    default:
      console.error(`[host] unknown bridge message: ${msg.type}`);
  }
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function bootHost() {
  const profileDir = join(resolveDshHome(), 'profiles', NAME);
  if (!existsSync(profileDir)) {
    // Fresh machine: create the profile from the shipped `web` template
    // exactly like `dsh web` would on first run.
    statusFrame('boot', `initializing ${NAME} profile from web template`);
    initializeProfileFromDefault(NAME, 'web');
  }
  ensureDesktopAboutBundle(profileDir);
  const overlayPath = writeOverlayPatch();

  statusFrame('boot', 'running profile');
  const application = runProfile({
    environment: loadLayeredEnv(NAME),
    profile: NAME,
    patchFiles: [overlayPath],
    args: ['--no-open', '--port', PORT],
  });
  const settled = await application;
  ctx = settled.ctx;
  shutdownHandle = settled.shutdown;
  console.error('[host] boot: tree settled');

  // DSH Desktop public Host services (dsh-plugin-desktop contract): their
  // presence is how cross-environment package managers (dshmarket 1.6+)
  // recognize this host; without them they fall back to spawning a PATH
  // `dsh` and apps launched from a .desktop entry fail with spawn dsh ENOENT.
  try {
    ctx.provide?.('desktopProfiles', createDesktopProfilesService({ name: NAME, dir: profileDir }));
    ctx.provide?.('desktopPnpm', createDesktopPnpmService({
      profileDir,
      profileName: NAME,
      dshBin: join(DSH_ROOT, 'lib', 'bin.js'),
      logLine: (line) => console.error(`[desktop-pnpm] ${line}`),
    }));
  } catch (error) {
    console.error(`[host] desktop services unavailable: ${error?.message ?? error}`);
  }

  // The authenticated loopback origin the webview loads. BrowserAuth mints
  // the session cookie from the launch token on the first `/` hit.
  const port = ctx.webServer?.port ?? Number(PORT);
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}`);
  return { url };
}

async function main() {
  let url = null;
  try {
    const booted = await bootHost();
    url = booted.url;
    notificationDispose = installNotificationPumps(ctx);
    statusFrame('ready', 'host ready');
    frame({
      type: 'ready',
      ok: true,
      url,
      www: WWW_DIR,
      home: resolveDshHome(),
      profile: `${resolveDshHome()}/profiles/${NAME}`,
      pid: process.pid,
    });
    console.error(`[host] desktop host ready (profile=${NAME}, url=${url})`);
  } catch (error) {
    console.error('[host] boot failed:', error);
    statusFrame('failed', String(error?.stack ?? error));
    frame({ type: 'ready', ok: false, error: String(error?.stack ?? error) });
    return;
  }

  // ── framed stdin parser ──────────────────────────────────────────────
  // The Rust shell writes one JSON header line per message; a header that
  // carries `bodyLen` is followed by exactly `bodyLen` raw bytes. A
  // force-killed shell surfaces as EOF, which shuts the host down.
  let pending = null;
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
    if (shutdownHandle !== null) {
      await shutdownHandle.shutdown(0);
    } else {
      await ctx?.fiber.dispose();
    }
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
// resume() lets EOF surface before the data loop attaches.
process.stdin.resume();

await main();
