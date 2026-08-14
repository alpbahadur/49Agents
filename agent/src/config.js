import { join } from 'path';
import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { DEFAULT_CLOUD_URL, getInstanceKey, isDefaultInstance, getTtydPortRange, getTmuxCommand } from './instance.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let version = '0.1.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  version = pkg.version;
} catch {
  // Use default version
}

const rootDir = process.env.TC_CONFIG_DIR || join(homedir(), '.49agents');

// The instance key comes from the environment only. The saved cloud-url file
// lives inside the instance directory, so it cannot be used to locate that
// directory in the first place; a non-default instance is selected by setting
// TC_CLOUD_URL (or TC_INSTANCE) before starting the agent.
const instanceKey = getInstanceKey(process.env.TC_CLOUD_URL);

// The default instance keeps the historical flat layout so existing installs
// find their token and PID file exactly where they left them.
const configDir = isDefaultInstance(instanceKey)
  ? rootDir
  : join(rootDir, 'instances', instanceKey);

/**
 * Resolve the cloud URL: explicit environment wins, then the URL saved by
 * `49-agent config` for this instance, then the local default.
 */
function resolveCloudUrl() {
  if (process.env.TC_CLOUD_URL) return process.env.TC_CLOUD_URL;

  const savedPath = join(configDir, 'cloud-url');
  if (existsSync(savedPath)) {
    const saved = readFileSync(savedPath, 'utf-8').trim();
    if (saved) return saved;
  }

  return DEFAULT_CLOUD_URL;
}

export const config = {
  cloudUrl: resolveCloudUrl(),
  configDir,
  dataDir: configDir,
  instanceKey,
  ttydPortRange: getTtydPortRange(instanceKey),
  tmuxCommand: getTmuxCommand(instanceKey),
  version,
};
