#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TARGETS } from './build-standalone-release.js';
import { TARGETS } from './create-standalone-package.js';
import { isStandaloneArchiveName } from './release-asset-config.js';
import {
  fail,
  isMainModule,
  parseCliArgs,
  parseSha256Sums,
  sha256File,
} from './release-script-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const EXPECTED_STANDALONE_ARCHIVE_NAMES = RELEASE_TARGETS.map(
  ({ qwenTarget }) => standaloneArchiveName(qwenTarget),
);
// Release artifacts that the installer chain expects in a GitHub Release.
// Hosted installer scripts (install-qwen.sh / install-qwen.bat) are served
// from a separate hosted endpoint and are intentionally not part of this set;
// they have their own staging path in `package:hosted-installation`.
const EXPECTED_RELEASE_ASSET_NAMES = [
  ...EXPECTED_STANDALONE_ARCHIVE_NAMES,
  'SHA256SUMS',
];

const CLI_OPTIONS = {
  '--help': { name: 'help', type: 'boolean' },
  '-h': { name: 'help', type: 'boolean' },
  '--dir': { name: 'dir' },
  '--base-url': { name: 'baseUrl' },
};

if (isMainModule(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), CLI_OPTIONS, {
    help: false,
    dir: undefined,
    baseUrl: undefined,
  });
  if (args.help) {
    printUsage();
    return;
  }
  if (args.dir && args.baseUrl) {
    fail('Pass --dir or --base-url, not both.');
  }
  if (args.baseUrl) {
    await verifyReleaseBaseUrl(args.baseUrl);
    return;
  }
  await verifyReleaseDirectory(
    path.resolve(args.dir || path.join(rootDir, 'dist', 'standalone')),
  );
}

function printUsage() {
  console.log(`Usage: npm run verify:installation-release -- [options]

Verifies that an installation release directory or release URL contains the
expected standalone archives and a SHA256SUMS file that covers them with
matching content hashes.

Options:
  --dir PATH         Verify a local release directory. Defaults to dist/standalone.
  --base-url URL     Verify a remote release URL (e.g. a GitHub release download
                     prefix). Cannot be combined with --dir.
  -h, --help         Show this help message.
`);
}

async function verifyReleaseDirectory(dir) {
  const checksums = readReleaseChecksums(dir);
  assertExpectedChecksumEntries(checksums);

  const unexpected = fs
    .readdirSync(dir)
    .filter((fileName) => !EXPECTED_RELEASE_ASSET_NAMES.includes(fileName))
    .sort();
  if (unexpected.length > 0) {
    fail(`Unexpected file(s) in release directory: ${unexpected.join(', ')}`);
  }

  const results = await Promise.allSettled(
    EXPECTED_STANDALONE_ARCHIVE_NAMES.map(async (assetName) => {
      const assetPath = path.join(dir, assetName);
      if (!fs.existsSync(assetPath)) {
        fail(`Missing release asset: ${assetName}`);
      }

      const actual = await sha256File(assetPath);
      if (actual !== checksums.get(assetName)) {
        fail(`Checksum verification failed for ${assetName}`);
      }
    }),
  );
  const firstFailure = results.find((result) => result.status === 'rejected');
  if (firstFailure) {
    throw firstFailure.reason;
  }

  console.log(
    `Verified ${EXPECTED_RELEASE_ASSET_NAMES.length} installation release assets in ${dir}`,
  );
}

async function verifyReleaseBaseUrl(baseUrl, options = {}) {
  const { fetchImpl = fetch } = options;
  const normalizedBaseUrl = normalizeHttpsBaseUrl(baseUrl);
  const checksumUrl = new URL('SHA256SUMS', normalizedBaseUrl).toString();
  const checksums = parseSha256Sums(await fetchText(checksumUrl, fetchImpl));
  assertExpectedChecksumEntries(checksums);

  for (const assetName of EXPECTED_STANDALONE_ARCHIVE_NAMES) {
    await assertRemoteAssetAvailable(
      new URL(assetName, normalizedBaseUrl).toString(),
      fetchImpl,
    );
  }

  console.log(
    `Verified ${EXPECTED_RELEASE_ASSET_NAMES.length} installation release asset URLs at ${baseUrl}`,
  );
}

function readReleaseChecksums(dir) {
  const checksumPath = path.join(dir, 'SHA256SUMS');
  if (!fs.existsSync(checksumPath)) {
    fail(`SHA256SUMS was not found at ${checksumPath}`);
  }

  return parseSha256Sums(fs.readFileSync(checksumPath, 'utf8'));
}

function assertExpectedChecksumEntries(checksums) {
  const expected = new Set(EXPECTED_STANDALONE_ARCHIVE_NAMES);
  const missing = EXPECTED_STANDALONE_ARCHIVE_NAMES.filter(
    (assetName) => !checksums.has(assetName),
  );
  const extra = Array.from(checksums.keys()).filter(
    (assetName) =>
      isStandaloneArchiveName(assetName) && !expected.has(assetName),
  );

  if (missing.length > 0) {
    fail(`Missing release asset checksum: ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    fail(`Unexpected release asset checksum: ${extra.join(', ')}`);
  }
}

async function assertRemoteAssetAvailable(url, fetchImpl) {
  let response = await fetchImpl(url, { method: 'HEAD' });
  if (response.ok) {
    await response.body?.cancel?.();
    return;
  }
  await response.body?.cancel?.();

  // Some object-storage hosts disable HEAD; fall back to a 1-byte ranged GET
  // so the verifier can still confirm reachability without downloading the
  // full archive.
  response = await fetchImpl(url, {
    headers: {
      Range: 'bytes=0-0',
    },
  });
  const status = response.status;
  const ok = response.ok;
  await response.body?.cancel?.();
  if (!ok) {
    fail(`Release asset URL is not available: ${url}`);
  }
  if (status !== 206) {
    fail(`Release asset URL does not support ranged GET: ${url}`);
  }
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    fail(
      `Failed to download ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

function normalizeHttpsBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    fail(`--base-url must be a valid URL: ${baseUrl}`);
  }
  // Real release URLs are always HTTPS. Tests use injected fetchImpl, so
  // they don't need a real protocol. Rejecting non-https early prevents an
  // operator from accidentally pointing the verifier at a plain-http mirror.
  if (parsed.protocol !== 'https:') {
    fail(`--base-url must use https: ${baseUrl}`);
  }
  if (isPrivateOrReservedHost(parsed.hostname)) {
    fail(`--base-url must not target a private network: ${baseUrl}`);
  }
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }
  return parsed.toString();
}

function standaloneArchiveName(qwenTarget) {
  const targetConfig = TARGETS.get(qwenTarget);
  if (!targetConfig) {
    fail(`Unknown release target: ${qwenTarget}`);
  }
  return `qwen-code-${qwenTarget}.${targetConfig.outputExtension}`;
}

function isPrivateOrReservedHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }

  const ipv4Parts = normalized.split('.');
  if (ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d+$/.test(part))) {
    const octets = ipv4Parts.map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) {
      return false;
    }
    const [first, second] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  if (!normalized.includes(':')) {
    return false;
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

export {
  EXPECTED_STANDALONE_ARCHIVE_NAMES,
  verifyReleaseBaseUrl,
  verifyReleaseDirectory,
};
