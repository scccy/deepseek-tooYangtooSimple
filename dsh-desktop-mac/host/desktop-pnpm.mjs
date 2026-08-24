/**
 * The DSH Desktop public plugin services — `desktopProfiles` and
 * `desktopPnpm` — implemented for the macOS in-process host.
 *
 * Third-party package managers such as `dshmarket` detect the desktop host
 * through `ctx.get('desktopProfiles')`; when that service is absent they
 * fall back to `spawn('dsh')` with an unconditionally trimmed PATH, which
 * fails with `spawn dsh ENOENT` for apps launched from Finder/Dock. Providing
 * these two Host services routes install/update/uninstall through the dsh CLI
 * owned by this app (same node, same global dsh, same ~/.dsh profile).
 *
 * Contract: dsh-plugin-desktop/docs/plugin-services.md (DSH Desktop 2.x).
 *
 * @module dsh-desktop-mac/desktop-pnpm
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';

const BUSY_MESSAGE = 'another desktop pnpm operation is already running';

/** Argv validation shared by `run` and `runPlugin` (throws synchronously). */
export function validatePluginArgs(args) {
	if (!Array.isArray(args) || args.length === 0) {
		throw new Error('desktopPnpm: args must be a non-empty string array');
	}
	for (const arg of args) {
		if (typeof arg !== 'string') {
			throw new Error('desktopPnpm: args must be a non-empty string array');
		}
		if (arg.includes('\0')) {
			throw new Error('desktopPnpm: args must not contain NUL characters');
		}
	}
	return args;
}

function validateAbsolutePath(value, label) {
	if (!isAbsolute(value) || value.includes('\0')) {
		throw new Error(`desktopPnpm: ${label} must be an absolute path without NUL`);
	}
	return value;
}

/**
 * Kill a child and its whole process tree. macPOSIX children below are
 * spawned detached in their own process group, so cancellation signals the
 * group with a SIGKILL escalation; Windows falls back to taskkill /T /F.
 */
function killChildTree(child) {
	if (child === null || child.pid === undefined) return;
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === 'win32') {
		try {
			const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
			killer.on('error', () => {
				/* taskkill unavailable: nothing more we can do */
			});
			return;
		} catch {
			/* fall through to child.kill */
		}
	}
	try {
		process.kill(-child.pid, 'SIGTERM');
	} catch {
		try {
			child.kill('SIGTERM');
		} catch {
			/* already gone */
		}
		return;
	}
	const escalate = setTimeout(() => {
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch {
			/* already gone */
		}
	}, 5000);
	escalate.unref?.();
}

/**
 * Environment for every package-tool child. GUI launches on macOS inherit a
 * minimal PATH (no /usr/local, no Homebrew, no nvm/fnm), so the resolved node
 * binary's own bin directory is prepended — the same prefix where `dsh` and
 * `pnpm` live for a `npm i -g @deepseek-ai/dsh` install.
 */
function toolEnvironment() {
	const bin = dirname(process.execPath);
	const parts = (process.env.PATH ?? '').split(delimiter).filter((part) => part !== '');
	const path = [bin, ...parts.filter((part) => part !== bin)].join(delimiter);
	return { ...process.env, CI: 'true', PATH: path };
}

/**
 * Start one tool invocation and expose Node Readable streams plus a `done`
 * outcome, matching the `DesktopPnpmHandle` contract. The consumer owns
 * timeouts and cancellation.
 */
function startToolOperation(file, args, cwd, { logLine } = {}) {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	let child = null;
	let settled = false;
	const done = new Promise((resolveDone, rejectDone) => {
		try {
			child = spawn(file, args, {
				cwd,
				env: toolEnvironment(),
				stdio: ['ignore', 'pipe', 'pipe'],
				// Own process group so cancel can kill the whole tree (dsh
				// wrapper + pnpm grandchildren) with one group signal.
				detached: process.platform !== 'win32',
				windowsHide: true,
			});
		} catch (error) {
			stdout.end();
			stderr.end();
			settled = true;
			rejectDone(error);
			return;
		}
		child.stdout.pipe(stdout);
		child.stderr.pipe(stderr);
		child.on('error', (error) => {
			if (settled) return;
			settled = true;
			stdout.end();
			stderr.end();
			rejectDone(error);
		});
		child.on('close', (code, signal) => {
			if (settled) return;
			settled = true;
			stdout.end();
			stderr.end();
			logLine?.(`${[file, ...args].join(' ').slice(0, 100)} → ${code ?? signal ?? '?'}`);
			resolveDone({ exitCode: code, signal: signal ?? null });
		});
	});
	return {
		stdout,
		stderr,
		done,
		cancel() {
			if (child !== null) killChildTree(child);
		},
	};
}

/**
 * Create the generation-scoped `desktopPnpm` service.
 *
 * `run` executes the user's pnpm in the active profile directory; `runPlugin`
 * re-invokes the global dsh CLI (`dsh plugin --profile <active> …`) with the
 * caller's cwd, so official behavior — profile initialization, relative
 * file/link anchoring and `dsh.profile.bundles` reconciliation — stays with
 * the dsh CLI. Both methods share one operation gate per generation.
 *
 * @param {{profileDir: string, profileName: string, dshBin: string, pnpmBin?: string, logLine?: (line: string) => void}} options
 */
export function createDesktopPnpmService({ profileDir, profileName, dshBin, pnpmBin, logLine }) {
	validateAbsolutePath(profileDir, 'profileDir');
	if (typeof profileName !== 'string' || profileName === '' || profileName.includes('\0')) {
		throw new Error('desktopPnpm: profileName must be a non-empty string without NUL');
	}
	if (!dshBin || !isAbsolute(dshBin) || !existsSync(dshBin)) {
		throw new Error(`desktopPnpm: dshBin must be an existing absolute path (got ${String(dshBin)})`);
	}
	const pnpm = pnpmBin ?? (() => {
		const besideNode = join(dirname(process.execPath), process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
		return existsSync(besideNode) ? besideNode : 'pnpm';
	})();
	let active = null;

	function start(file, args, cwd, { signal }) {
		if (active !== null) throw new Error(BUSY_MESSAGE);
		if (signal?.aborted === true) {
			throw new Error('desktopPnpm: operation was already aborted');
		}
		const operation = startToolOperation(file, args, cwd, { logLine });
		const record = { operation };
		active = record;
		const onAbort = () => operation.cancel();
		const release = () => {
			signal?.removeEventListener('abort', onAbort);
			if (active === record) active = null;
		};
		signal?.addEventListener('abort', onAbort, { once: true });
		const done = operation.done.then(
			(outcome) => {
				release();
				return outcome;
			},
			(error) => {
				release();
				throw error;
			},
		);
		return { stdout: operation.stdout, stderr: operation.stderr, done, cancel: () => operation.cancel() };
	}

	return {
		/** Run the user's pnpm directly in the active profile directory. */
		run(args, signal) {
			return start(pnpm, validatePluginArgs(args), profileDir, { signal });
		},
		/** `dsh plugin --profile <active> …` over the same global CLI the shell uses. */
		runPlugin(args, invokingDir, signal) {
			validateAbsolutePath(invokingDir, 'invokingDir');
			const fullArgs = [dshBin, 'plugin', '--profile', profileName, ...validatePluginArgs(args)];
			return start(process.execPath, fullArgs, invokingDir, { signal });
		},
	};
}

/**
 * Create the generation-scoped `desktopProfiles` service. This build boots
 * exactly the Rust-resolved profile per generation, so `list()` exposes that
 * profile and `select()` only ever resolves for the already-active name.
 */
export function createDesktopProfilesService({ name, dir }) {
	if (typeof name !== 'string' || name === '' || name.includes('\0')) {
		throw new Error('desktopProfiles: profile name must be a non-empty string without NUL');
	}
	validateAbsolutePath(dir, 'desktopProfiles dir');
	const current = Object.freeze({ name, dir });
	return {
		current,
		list() {
			return [current];
		},
		select(target) {
			if (typeof target !== 'string' || target === '') {
				return Promise.reject(new Error('desktopProfiles: invalid profile name'));
			}
			if (target === current.name) return Promise.resolve();
			return Promise.reject(new Error(`desktopProfiles: profile switching is not supported in this desktop build (requested ${target})`));
		},
	};
}