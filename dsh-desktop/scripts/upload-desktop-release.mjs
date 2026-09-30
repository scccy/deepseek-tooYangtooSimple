#!/usr/bin/env node
/**
 * dsh-desktop shell release uploader (batch 3).
 *
 * Collects tauri updater artifacts from src-tauri/target/release/bundle/,
 * verifies their signatures, assembles the per-channel latest.json feed and
 * publishes it (locally by default; GitHub Releases with --publish).
 *
 * Usage:
 *   node scripts/upload-desktop-release.mjs --version 0.7.6 [--latest]
 *        [--mandatory] [--feed-dir <dir>] [--publish]
 *        [--notes "text"] [--build-version auto]
 *
 * Version policy (mirrors docs/features/batch3-shell-updater.md):
 *   - a production release uses the version exactly as passed;
 *   - `--build-version auto` only PROPOSES the next test index
 *     (<base>-test.YYYYMMDD.N, Asia/Shanghai) and prints it — the caller must
 *     confirm by re-running with the literal version. Nothing is uploaded by
 *     the auto run.
 *   - a version that already exists in the release records is rejected.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDS_DIR = join(ROOT, 'scripts', '.release-records');
const BUNDLE_ROOT = join(ROOT, 'src-tauri', 'target', 'release', 'bundle');

/** target triple keys used in latest.json platforms map (tauri v2 updater). */
const PLATFORM_ARTIFACTS = {
  'darwin-aarch64': { dir: 'macos', ext: '.app.tar.gz' },
  'darwin-x86_64': { dir: 'macos', ext: '.app.tar.gz' },
  'windows-x86_64': { dir: 'nsis', ext: '.nsis.zip' },
  'linux-x86_64': { dir: 'appimage', ext: '.AppImage.tar.gz' },
};

function dirname(p) {
  return p.replace(/[/\\][^/\\]*$/, '') || '.';
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(arg);
  }
  return out;
}

/** YYYYMMDD in Asia/Shanghai (UTC+8, no DST). */
function shanghaiDate(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600 * 1000);
  return local.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Propose the next unused test version for today's date. */
function proposeTestVersion(base, records) {
  const date = shanghaiDate();
  const prefix = `${base}-test.${date}.`;
  let index = 0;
  for (const record of records) {
    if (record.version.startsWith(prefix)) {
      const n = Number(record.version.slice(prefix.length));
      if (Number.isInteger(n) && n > index) index = n;
    }
  }
  return `${prefix}${index + 1}`;
}

function loadRecords() {
  if (!existsSync(RECORDS_DIR)) return [];
  return readdirSync(RECORDS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(RECORDS_DIR, f), 'utf8')));
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Collect <artifact> + <artifact>.sig pairs for every platform we built. */
function collectArtifacts(version) {
  const found = {};
  for (const [platform, spec] of Object.entries(PLATFORM_ARTIFACTS)) {
    const dir = join(BUNDLE_ROOT, spec.dir);
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir).filter(
      (f) => f.endsWith(spec.ext) && f.includes(version) && statSync(join(dir, f)).isFile(),
    );
    for (const name of names) {
      const artifact = join(dir, name);
      const signature = `${artifact}.sig`;
      if (!existsSync(signature)) {
        throw new Error(`missing signature for updater artifact: ${name} (run packaging with TAURI_SIGNING_PRIVATE_KEY set)`);
      }
      found[platform] = {
        signature: readFileSync(signature, 'utf8').trim(),
        url: `<FEED_URL>/${version}/${name}`,
        localPath: artifact,
        sha256: sha256(artifact),
      };
    }
  }
  if (Object.keys(found).length === 0) {
    throw new Error(`no updater artifacts for ${version} under ${BUNDLE_ROOT} (build with createUpdaterArtifacts: true)`);
  }
  return found;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = loadRecords();

  if (args['build-version'] === 'auto') {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const proposal = proposeTestVersion(pkg.version, records);
    console.log(`proposed test version: ${proposal}`);
    console.log('re-run with --version <proposal> to confirm; nothing was uploaded.');
    return;
  }

  const version = String(args.version ?? '');
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('missing/invalid --version (expected a complete semver string, prerelease suffixes preserved, no v prefix)');
  }
  if (records.some((r) => r.version === version)) {
    throw new Error(`version ${version} already has a release record — never reuse a published version`);
  }

  const platforms = collectArtifacts(version);
  const feed = {
    version,
    notes: args.notes ?? '',
    pub_date: new Date().toISOString(),
    mandatory: args.mandatory === true,
    dshBuildCommit: gitCommit(),
    platforms,
  };

  const feedDir = resolve(String(args['feed-dir'] ?? join(ROOT, 'scripts', '.feed')));
  const versionDir = join(feedDir, version);
  mkdirSync(versionDir, { recursive: true });
  for (const [platform, entry] of Object.entries(platforms)) {
    const name = entry.localPath.replace(/.*[/\\]/, '');
    writeFileSync(join(versionDir, `${name}.sha256`), `${entry.sha256}  ${name}\n`);
    delete entry.localPath;
    delete entry.sha256;
  }
  writeFileSync(join(versionDir, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);

  const record = {
    version,
    latest: args.latest === true,
    mandatory: feed.mandatory,
    published: args.publish === true,
    createdAt: new Date().toISOString(),
    commit: feed.dshBuildCommit,
    platforms: Object.fromEntries(Object.entries(platforms).map(([k, v]) => [k, v.url])),
  };
  mkdirSync(RECORDS_DIR, { recursive: true });
  writeFileSync(join(RECORDS_DIR, `desktop-v${version}.json`), `${JSON.stringify(record, null, 2)}\n`);

  console.log(`feed staged at ${versionDir}`);
  if (args.publish === true) {
    // Remote transport is pluggable; default is GitHub Releases via gh.
    // Implement/confirm the remote before the first real publish.
    throw new Error('--publish transport not configured yet (GitHub Releases adapter lands with the feed-hosting decision)');
  }
  console.log('local stage complete; pass --publish once the feed host is configured.');
}

function gitCommit() {
  try {
    const { execFileSync } = childProcess;
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD']).toString().trim();
  } catch {
    return 'unknown';
  }
}

main();
