/**
 * Agent Self-Updater
 *
 * Downloads the latest agent tarball from the cloud server, backs up
 * the current installation, extracts the new version, and exits so
 * systemd (or equivalent) can restart the process.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { config } from './config.js';

// Hostnames for which a plain-HTTP update download is acceptable.
//
// The HTTPS requirement below exists to stop a network attacker tampering with
// the tarball in transit. On a private network there is no such transit to
// attack, and plain HTTP is a first-class configuration here: the installer
// emits ws:// for any non-secure request (cloud/src/routes/download.js), and
// start.sh prompts for a cloud URL using ws://192.168.1.10:1071 as its example.
// Requiring HTTPS for those would leave every LAN-hosted agent permanently
// unable to update itself.
export function isPrivateHost(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 127) return true;                       // loopback
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;          // link-local
    return false;
  }

  // mDNS and common private suffixes.
  if (/\.(local|internal|lan|home\.arpa)$/.test(host)) return true;

  // A single-label name has no public TLD to resolve against, so it can only
  // be a name from local DNS or mDNS — 'ws://myserver:1071' and the like.
  if (!host.includes('.')) return true;

  return false;
}

/**
 * Perform the self-update.
 *
 * @param {Function} sendProgress - function(status) to report progress
 * @returns {Promise<void>}
 */
export async function performUpdate(sendProgress) {
  const installDir = join(config.dataDir, 'agent');
  const backupDir = join(config.dataDir, 'agent.bak');
  const updateDir = join(config.dataDir, '.update');
  const tarballPath = join(updateDir, '49-agent.tar.gz');

  // Derive HTTP download URL from the WebSocket cloud URL
  const cloudUrl = config.cloudUrl
    .replace('wss://', 'https://')
    .replace('ws://', 'http://');
  const downloadUrl = `${cloudUrl}/dl/49-agent.tar.gz`;

  const lockFile = join(config.dataDir, '.update.lock');
  if (existsSync(lockFile)) {
    throw new Error('Update already in progress');
  }
  writeFileSync(lockFile, Date.now().toString());

  try {
    // 1. Download
    sendProgress('downloading');
    mkdirSync(updateDir, { recursive: true });
    console.log(`[Updater] Downloading from ${downloadUrl}...`);
    // Refuse to fetch the tarball over plain HTTP from a public host: it is
    // extracted and executed, so a network attacker who can rewrite it owns the
    // machine. Private and loopback hosts are exempt — see isPrivateHost.
    const parsedDownloadUrl = new URL(downloadUrl);
    if (parsedDownloadUrl.protocol !== 'https:' && !isPrivateHost(parsedDownloadUrl.hostname)) {
      throw new Error(
        `Update downloads require HTTPS for public servers; got ${parsedDownloadUrl.protocol}//${parsedDownloadUrl.host}`,
      );
    }
    // No -L: the tarball is served directly by the cloud (res.sendFile), so a
    // redirect would only ever be taking the download somewhere unintended.
    const result = spawnSync('curl', ['-fsS', downloadUrl, '-o', tarballPath], {
      timeout: 60000,
    });
    if (result.status !== 0) {
      throw new Error(`Download failed: ${result.stderr?.toString() || 'unknown error'}`);
    }

    // 2. Install
    sendProgress('installing');

    // Extract to temp dir first to verify integrity
    const extractDir = join(updateDir, 'extracted');
    mkdirSync(extractDir, { recursive: true });
    const extractResult = spawnSync('tar', ['xzf', tarballPath, '-C', extractDir], {
      timeout: 30000,
    });
    if (extractResult.status !== 0) {
      throw new Error(`Extraction failed: ${extractResult.stderr?.toString() || 'unknown error'}`);
    }

    // Verify the extracted content has the expected structure
    const newAgentDir = join(extractDir, 'agent');
    if (!existsSync(join(newAgentDir, 'package.json'))) {
      throw new Error('Invalid tarball: missing agent/package.json');
    }

    // Back up current installation
    if (existsSync(backupDir)) {
      rmSync(backupDir, { recursive: true, force: true });
    }
    if (existsSync(installDir)) {
      renameSync(installDir, backupDir);
      console.log(`[Updater] Backed up current install to ${backupDir}`);
    }

    // Move new version into place
    renameSync(newAgentDir, installDir);
    console.log('[Updater] New version installed');

    // Clean up
    rmSync(updateDir, { recursive: true, force: true });

    // 3. Restart
    sendProgress('restarting');
    console.log('[Updater] Restarting agent...');

    // Exit with code 0 — systemd Restart=always will bring us back
    // Small delay to allow the progress message to send
    const RESTART_DELAY_MS = 2000;
    setTimeout(() => {
      process.exit(0);
    }, RESTART_DELAY_MS);

  } catch (err) {
    console.error('[Updater] Update failed:', err.message);
    sendProgress('failed');

    // Attempt rollback if backup exists and current is missing
    if (!existsSync(installDir) && existsSync(backupDir)) {
      try {
        renameSync(backupDir, installDir);
        console.log('[Updater] Rolled back to previous version');
      } catch (rollbackErr) {
        console.error('[Updater] Rollback failed:', rollbackErr.message);
      }
    }

    // Clean up temp files
    try { rmSync(updateDir, { recursive: true, force: true }); } catch {}

    throw err;
  } finally {
    try { unlinkSync(lockFile); } catch {}
  }
}
