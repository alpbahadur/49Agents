#!/usr/bin/env node

import { startAgent } from '../src/index.js';
import { loadToken, saveToken, clearToken } from '../src/auth.js';
import { config } from '../src/config.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PID_FILE = join(config.configDir, 'agent.pid');

const args = process.argv.slice(2);
const command = args[0] || 'help';

switch (command) {
  case 'login':
    await handleLogin();
    break;
  case 'start':
    await handleStart();
    break;
  case 'status':
    handleStatus();
    break;
  case 'stop':
    handleStop();
    break;
  case 'config':
    await handleConfig();
    break;
  case 'install-service':
    handleInstallService();
    break;
  case 'help':
  default:
    printHelp();
    break;
}

async function handleLogin() {
  // Accept token from command line or stdin
  const tokenArg = args[1];

  if (tokenArg) {
    saveToken(tokenArg);
    console.log('[49-agent] Token saved successfully.');
    return;
  }

  // Interactive: prompt for token
  console.log('[49-agent] Login to 49Agents Cloud');
  console.log('');
  console.log('  Visit your 49Agents dashboard to get an agent pairing token,');
  console.log('  then run:');
  console.log('');
  console.log('    49-agent login <YOUR_TOKEN>');
  console.log('');

  // Try to read from stdin if piped
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const token = Buffer.concat(chunks).toString().trim();
    if (token) {
      saveToken(token);
      console.log('[49-agent] Token saved successfully.');
    }
  }
}

/**
 * The PID of a live agent already serving this instance, or null.
 *
 * Two agents on one instance share a token, so they authenticate as the same
 * agent and the relay closes whichever connected first — the running agent
 * disappears with no indication of why. They also drive the same tmux
 * sessions. Checking the PID file first turns that into a refusal to start.
 *
 * A PID file left behind by a crash is not a running agent, so a stale entry
 * is cleared rather than treated as a conflict.
 */
function findRunningAgent() {
  if (!existsSync(PID_FILE)) return null;

  let pid;
  try {
    pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;

  try {
    process.kill(pid, 0); // signal 0 tests for existence without delivering
    return pid;
  } catch {
    // No such process: the file outlived the agent that wrote it.
    try { unlinkSync(PID_FILE); } catch { /* already gone */ }
    return null;
  }
}

function refuseDuplicateStart(pid) {
  console.error(`[49-agent] An agent is already running for this instance (PID: ${pid}).`);
  console.error(`[49-agent]   Instance:  ${config.instanceKey}`);
  console.error(`[49-agent]   Cloud URL: ${config.cloudUrl}`);
  console.error('');
  console.error('  Starting a second agent here would disconnect the first one and');
  console.error('  drive the same terminals. Either stop it:');
  console.error('');
  console.error('    49-agent stop');
  console.error('');
  console.error('  or point this agent at a different server, which gives it its own');
  console.error('  config directory, terminal ports and tmux server:');
  console.error('');
  console.error('    TC_CLOUD_URL=ws://localhost:<other-port> 49-agent start');
  console.error('');
  process.exit(1);
}

async function handleStart() {
  const isDaemon = args.includes('--daemon') || args.includes('-d');
  const force = args.includes('--force');

  const running = findRunningAgent();
  if (running && !force) {
    refuseDuplicateStart(running);
  }

  if (isDaemon) {
    // Fork to background
    const child = fork(join(__dirname, '49-agent.js'), ['start'], {
      detached: true,
      stdio: 'ignore',
    });

    // Ensure config dir exists for PID file
    mkdirSync(config.configDir, { recursive: true });
    writeFileSync(PID_FILE, String(child.pid));
    child.unref();

    console.log(`[49-agent] Agent started in background (PID: ${child.pid})`);
    console.log(`[49-agent] PID file: ${PID_FILE}`);
    console.log(`[49-agent] Use "49-agent stop" to stop the agent.`);
    process.exit(0);
  }

  // Foreground mode
  let token = loadToken();
  // config.cloudUrl already applies the priority: TC_CLOUD_URL env var >
  // saved cloud-url file for this instance > local default.
  const cloudUrl = config.cloudUrl;

  if (!token) {
    // No token — default to local dev mode, no prompts needed
    token = 'dev';
    console.log(`[49-agent] No token found — connecting to local server at ${cloudUrl}.`);
    console.log('[49-agent] To change host/port, run: 49-agent config');
  }

  // Write PID file for foreground process too (so status/stop work)
  mkdirSync(config.configDir, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));

  // Clean up PID file on exit
  const cleanupPid = () => {
    try {
      if (existsSync(PID_FILE)) {
        const storedPid = readFileSync(PID_FILE, 'utf-8').trim();
        if (storedPid === String(process.pid)) {
          unlinkSync(PID_FILE);
        }
      }
    } catch { /* ignore */ }
  };
  process.on('exit', cleanupPid);

  await startAgent({ token, cloudUrl });
}

function handleStatus() {
  const token = loadToken();
  const hasPid = existsSync(PID_FILE);
  let pid = null;
  let running = false;

  if (hasPid) {
    pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    try {
      process.kill(pid, 0); // Check if process exists
      running = true;
    } catch {
      running = false;
    }
  }

  console.log(`49Agents Agent v${config.version}`);
  console.log(`  Cloud URL:     ${config.cloudUrl}`);
  console.log(`  Instance:      ${config.instanceKey}`);
  console.log(`  Terminal ports:${` ${config.ttydPortRange.start}-${config.ttydPortRange.end}`}`);
  console.log(`  Config dir:    ${config.configDir}`);
  console.log(`  Token:         ${token ? 'configured' : 'NOT configured'}`);
  console.log(`  Agent status:  ${running ? `running (PID: ${pid})` : 'stopped'}`);
}

function handleStop() {
  if (!existsSync(PID_FILE)) {
    console.log('[49-agent] No PID file found. Agent may not be running.');
    return;
  }

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[49-agent] Sent SIGTERM to agent (PID: ${pid})`);
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  } catch (err) {
    if (err.code === 'ESRCH') {
      console.log('[49-agent] Agent process not found. Cleaning up PID file.');
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    } else {
      console.error('[49-agent] Failed to stop agent:', err.message);
    }
  }
}

function handleInstallService() {
  const platform = process.platform;

  if (platform === 'linux') {
    const serviceContent = `[Unit]
Description=49Agents Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${join(__dirname, '49-agent.js')} start
Restart=always
RestartSec=5
Environment=HOME=${process.env.HOME}
User=${process.env.USER}

[Install]
WantedBy=multi-user.target`;

    const servicePath = join(process.env.HOME, '.config', 'systemd', 'user', '49-agent.service');
    console.log('[49-agent] To install as a systemd user service:');
    console.log('');
    console.log(`  mkdir -p ~/.config/systemd/user`);
    console.log(`  cat > ${servicePath} << 'EOF'`);
    console.log(serviceContent);
    console.log('EOF');
    console.log('  systemctl --user daemon-reload');
    console.log('  systemctl --user enable 49-agent');
    console.log('  systemctl --user start 49-agent');
    console.log('');
  } else if (platform === 'darwin') {
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.49agents.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${join(__dirname, '49-agent.js')}</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TC_CLOUD_URL</key>
        <string>${config.cloudUrl}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>`;

    const plistPath = join(process.env.HOME, 'Library', 'LaunchAgents', 'com.49agents.agent.plist');
    console.log('[49-agent] To install as a launchd service:');
    console.log('');
    console.log(`  cat > ${plistPath} << 'EOF'`);
    console.log(plistContent);
    console.log('EOF');
    console.log(`  launchctl load ${plistPath}`);
    console.log('');
  } else {
    console.log('[49-agent] Service installation is only supported on Linux (systemd) and macOS (launchd).');
  }
}

async function handleConfig() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  console.log('');
  console.log('49Agents Agent Configuration');
  console.log('');
  console.log('  1) Single machine  (this machine only — default)');
  console.log('  2) Private network (specify a host on your network)');
  console.log('');

  const answer = (await ask('Enter choice [1/2, default: 1]: ')).trim() || '1';

  let host = 'localhost';
  if (answer === '2') {
    const hostInput = (await ask('Host or IP of the cloud server: ')).trim();
    host = hostInput || 'localhost';
  }

  const portInput = (await ask('Port the cloud server is running on [default: 1071]: ')).trim();
  rl.close();

  const port = portInput || '1071';
  const cloudUrl = `ws://${host}:${port}`;

  // Save as the agent token file with a special dev config marker
  saveToken('dev');
  // Persist the chosen cloudUrl via TC_CLOUD_URL hint in config dir
  mkdirSync(config.configDir, { recursive: true });
  writeFileSync(join(config.configDir, 'cloud-url'), cloudUrl, 'utf-8');

  console.log('');
  console.log(`[49-agent] Configured to connect to ${cloudUrl}`);
  console.log('[49-agent] Run "49-agent start" to connect.');
  console.log('');
}

function printHelp() {
  console.log(`49Agents Agent v${config.version}

Usage: 49-agent <command> [options]

Commands:
  start               Connect to local server (foreground) — no login needed
  start --daemon      Connect to local server (background)
  config              Set server host/port for private network setups
  status              Show agent status and configuration
  stop                Stop the background agent
  login [token]       Store a cloud authentication token (future use)
  install-service     Show instructions for system service installation
  help                Show this help message

Environment:
  TC_CLOUD_URL        Override cloud relay URL (default: ws://localhost:1071)
  TC_INSTANCE         Override the instance key used to isolate agent state
                      (config dir and terminal port range). Set automatically
                      from TC_CLOUD_URL; only needed to run two agents against
                      the same cloud server.
`);
}
