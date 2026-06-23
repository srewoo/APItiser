#!/usr/bin/env bash
# Register the APItiser local-runner native messaging host with your Chromium-based browser.
# Usage: ./install.sh <extension-id> [host-name]
set -euo pipefail

EXT_ID="${1:?Usage: ./install.sh <extension-id> [host-name]  (find the ID at chrome://extensions in Developer mode)}"
HOST_NAME="${2:-com.apitiser.localrunner}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Install into a stable, NON-TCC-protected location and register THAT. Running the host from
# ~/Downloads/~/Desktop/~/Documents fails silently — macOS denies Chrome's native-messaging
# launcher access to those folders ("Native host has exited"). ~/.apitiser/runner is safe.
TARGET="${APITISER_RUNNER_HOME:-$HOME/.apitiser/runner}"
if [[ "$DIR" != "$TARGET" ]]; then
  mkdir -p "$TARGET"
  cp -R "$DIR/." "$TARGET/"
  echo "Installed runner files → $TARGET"
fi

HOST_PATH="$TARGET/apitiser-runner.mjs"
LAUNCHER_PATH="$TARGET/apitiser-runner-launcher.sh"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || { echo "Node.js is required on PATH to run the host. Install Node and retry."; exit 1; }
[[ -f "$HOST_PATH" ]] || { echo "Host script missing: $HOST_PATH"; exit 1; }
chmod +x "$HOST_PATH"

# Preflight: report the base toolchain. The runner auto-handles per-repo dependencies, Docker
# startup, and Python venvs at run time — but it can only USE these base tools, not install
# them. Anything missing here is the one thing you may need to install yourself.
echo "Preflight — base toolchain (the runner handles repo deps/venv/Docker startup itself):"
preflight() {
  if command -v "$1" >/dev/null 2>&1; then
    printf '  [ ok ] %-8s %s\n' "$1" "$($1 $2 2>&1 | head -1)"
  else
    printf '  [MISS] %-8s not found — %s\n' "$1" "$3"
  fi
}
preflight git    "--version"  "install Git"
preflight docker "--version"  "install Docker Desktop (only for container/compose repos)"
preflight python3 "--version" "install Python (only for Python repos/tests)"
preflight go     "version"    "install Go (only for Go repos)"
echo

# Chrome launches native hosts with the minimal launchd PATH (/usr/bin:/bin:...), which does
# NOT include nvm/Homebrew node. So register a launcher that calls node by ABSOLUTE path via
# /bin/bash (always present) — robust regardless of how node was installed.
cat > "$LAUNCHER_PATH" <<LAUNCHER
#!/bin/bash
exec "$NODE_BIN" "$HOST_PATH" "\$@"
LAUNCHER
chmod +x "$LAUNCHER_PATH"

# Files unzipped from a browser download carry com.apple.quarantine, which can stop Chrome
# from exec'ing the host ("Native host has exited"). Clear it on the installed copy.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
fi

echo "Using node: $NODE_BIN"

case "$(uname -s)" in
  Darwin)
    BASES=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Beta/NativeMessagingHosts"
      "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    )
    ;;
  Linux)
    BASES=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Unsupported OS for this installer. See INSTALL.md for Windows registry steps."
    exit 1
    ;;
esac

# Escape backslashes and double-quotes so a path/id/host-name with special chars can't
# produce invalid JSON (which Chrome would silently refuse to load).
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

MANIFEST=$(cat <<JSON
{
  "name": "$(json_escape "$HOST_NAME")",
  "description": "APItiser local runner — boots a repo via runLocal for live test validation.",
  "path": "$(json_escape "$LAUNCHER_PATH")",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$(json_escape "$EXT_ID")/"]
}
JSON
)

installed=0
for base in "${BASES[@]}"; do
  parent="$(dirname "$base")"
  if [[ -d "$parent" ]]; then
    mkdir -p "$base"
    printf '%s\n' "$MANIFEST" > "$base/$HOST_NAME.json"
    echo "Installed → $base/$HOST_NAME.json"
    installed=1
  fi
done

if [[ $installed -eq 0 ]]; then
  echo "No supported browser profile directory found. Is the browser installed for this user?"
  exit 1
fi

echo
echo "Done. Host name: $HOST_NAME"
echo "Runner installed at: $TARGET"
echo "In APItiser Settings: enable 'Run locally', set the repo path, then click 'Check setup'."
