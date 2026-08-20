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
    const parsedDownloadUrl = new URL(downloadUrl);
    const isLocalhost = ['localhost', '127.0.0.1', '::1'].includes(parsedDownloadUrl.hostname);
    if (!isLocalhost && parsedDownloadUrl.protocol !== 'https:') {
      throw new Error(`Update downloads require HTTPS for non-local servers; got: ${parsedDownloadUrl.protocol}`);
    }
    const result = spawnSync('curl', ['-fsS', '--max-redirs', '0', downloadUrl, '-o', tarballPath], {
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
