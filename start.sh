#!/bin/bash
set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}49Agents — Setup${NC}"
echo "──────────────────────────────"
echo ""

# Install dependencies and build
echo -e "${YELLOW}Installing dependencies...${NC}"
(cd cloud && npm install --silent)
(cd agent && npm install --silent)
echo -e "${YELLOW}Building client assets...${NC}"
(cd cloud && npm run build --silent)
echo -e "${YELLOW}Building agent tarball...${NC}"
mkdir -p cloud/dl
tar czf cloud/dl/49-agent.tar.gz agent/
echo -e "${GREEN}Done.${NC}"
echo ""

# ── Setup type ──────────────────────────────────────────────
echo "How are you setting this up?"
echo ""
echo "  1) Single machine  — cloud + agent on this machine (default)"
echo "  2) Multi machine   — choose what runs on this machine"
echo ""
read -rp "Enter choice [1/2, default: 1]: " SETUP_CHOICE
SETUP_CHOICE="${SETUP_CHOICE:-1}"
echo ""

RUN_CLOUD=false
RUN_AGENT=false
CLOUD_PORT=1071
AGENT_CLOUD_URL=""

if [ "$SETUP_CHOICE" = "1" ]; then
  RUN_CLOUD=true
  RUN_AGENT=true
  read -rp "Port to run the server on [default: 1071]: " PORT_INPUT
  CLOUD_PORT="${PORT_INPUT:-1071}"
  AGENT_CLOUD_URL="ws://localhost:${CLOUD_PORT}"

elif [ "$SETUP_CHOICE" = "2" ]; then
  echo "What should this machine run?"
  echo ""
  echo "  1) Cloud server only"
  echo "  2) Agent only"
  echo "  3) Both"
  echo ""
  read -rp "Enter choice [1/2/3]: " ROLE_CHOICE
  echo ""

  if [ "$ROLE_CHOICE" = "1" ]; then
    RUN_CLOUD=true
    read -rp "Port to run the cloud server on [default: 1071]: " PORT_INPUT
    CLOUD_PORT="${PORT_INPUT:-1071}"

  elif [ "$ROLE_CHOICE" = "2" ]; then
    RUN_AGENT=true
    read -rp "URL of the cloud server (e.g. ws://192.168.1.10:1071): " URL_INPUT
    AGENT_CLOUD_URL="${URL_INPUT:-ws://localhost:1071}"

  elif [ "$ROLE_CHOICE" = "3" ]; then
    RUN_CLOUD=true
    RUN_AGENT=true
    read -rp "Port to run the cloud server on [default: 1071]: " PORT_INPUT
    CLOUD_PORT="${PORT_INPUT:-1071}"
    AGENT_CLOUD_URL="ws://localhost:${CLOUD_PORT}"

  else
    echo "Invalid choice. Exiting."
    exit 1
  fi

else
  echo "Invalid choice. Exiting."
  exit 1
fi

# ── Check/install tmux and ttyd (only if agent is running) ───
install_tmux() {
  echo ""
  read -rp "tmux is required for the agent. Install it now? [Y/n]: " CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    if [ "$OS" = "mac" ]; then
      brew install tmux
    elif command -v apt-get &>/dev/null; then
      sudo apt-get install -y tmux
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y tmux
    elif command -v yum &>/dev/null; then
      sudo yum install -y tmux
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm tmux
    else
      echo "Could not detect package manager. Please install tmux manually."
      exit 1
    fi
  else
    echo "tmux is required. Exiting."
    exit 1
  fi
}

install_ttyd() {
  echo ""
  read -rp "ttyd is required for the agent. Install it now? [Y/n]: " CONFIRM
  CONFIRM="${CONFIRM:-Y}"
  if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
    if [ "$OS" = "mac" ]; then
      brew install ttyd
    else
      # Download static binary from GitHub releases
      ARCH=$(uname -m)
      if [ "$ARCH" = "x86_64" ]; then
        TTYD_BINARY="ttyd.x86_64"
      elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
        TTYD_BINARY="ttyd.aarch64"
      else
        echo "Unsupported architecture: $ARCH. Please install ttyd manually from https://github.com/tsl0922/ttyd/releases"
        exit 1
      fi
      TTYD_VERSION=$(curl -s https://api.github.com/repos/tsl0922/ttyd/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
      echo "Downloading ttyd ${TTYD_VERSION}..."
      sudo curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${TTYD_BINARY}" -o /usr/local/bin/ttyd
      sudo chmod +x /usr/local/bin/ttyd
    fi
  else
    echo "ttyd is required. Exiting."
    exit 1
  fi
}

if [ "$RUN_AGENT" = true ]; then
  # Detect OS
  if [ "$(uname)" = "Darwin" ]; then
    OS="mac"
  else
    OS="linux"
  fi

  if ! command -v tmux &>/dev/null; then
    install_tmux
  fi

  if ! command -v ttyd &>/dev/null; then
    install_ttyd
  fi

  echo -e "${GREEN}tmux and ttyd are ready.${NC}"
  echo ""
fi

# ── Cleanup on exit ──────────────────────────────────────────
cleanup() {
  echo ""
  echo "Shutting down..."
  [ -n "$CLOUD_PID" ] && kill "$CLOUD_PID" 2>/dev/null
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

# ── Start services ───────────────────────────────────────────
echo ""

if [ "$RUN_CLOUD" = true ]; then
  echo -e "${YELLOW}Starting cloud server on port ${CLOUD_PORT}...${NC}"
  export PORT="$CLOUD_PORT"
  (cd cloud && node src/index.js) &
  CLOUD_PID=$!
  sleep 4
fi

if [ "$RUN_AGENT" = true ]; then
  echo -e "${YELLOW}Starting agent...${NC}"
  export TC_CLOUD_URL="$AGENT_CLOUD_URL"
  (cd agent && node bin/49-agent.js start) &
  AGENT_PID=$!
fi

# ── Summary ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}Running!${NC}"
if [ "$RUN_CLOUD" = true ]; then
  echo -e "  Cloud  → ${CYAN}http://localhost:${CLOUD_PORT}${NC}"
fi
if [ "$RUN_AGENT" = true ]; then
  echo -e "  Agent  → ${CYAN}${AGENT_CLOUD_URL}${NC}"
fi
if [ "$CLOUD_PORT" != "1071" ]; then
  echo ""
  echo "  Running on a non-default port: this instance keeps its own database"
  echo "  (cloud/data/tc-${CLOUD_PORT}.db), its own agent config directory, and"
  echo "  its own terminal port range, so it will not disturb an instance on 1071."
fi
echo ""
echo "Press Ctrl+C to stop."
echo ""

wait
