#!/usr/bin/env bash
# Build the Agent Status extension and install it into the local VS Code.
#
# Usage: ./install.sh [--no-build]
#   --no-build   install the existing .vsix without syncing and repackaging
#
# Finds the `code` CLI on the PATH, or inside VS Code.app / VS Code Insiders.app
# on macOS; set CODE_CLI to use another one. Reload VS Code windows afterwards
# (Developer: Reload Window) to load the new version.

set -euo pipefail

# Directory of this script: the extension root.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

# Locate the VS Code command-line tool.
find_code_cli() {
  if [[ -n "${CODE_CLI:-}" ]]; then echo "$CODE_CLI"; return; fi
  if command -v code >/dev/null 2>&1; then command -v code; return; fi
  local app
  for app in "/Applications/Visual Studio Code.app" "$HOME/Applications/Visual Studio Code.app" \
             "/Applications/Visual Studio Code - Insiders.app"; do
    local cli="$app/Contents/Resources/app/bin/code"
    [[ "$app" == *Insiders* ]] && cli="$app/Contents/Resources/app/bin/code-insiders"
    if [[ -x "$cli" ]]; then echo "$cli"; return; fi
  done
  echo "error: VS Code CLI not found; set CODE_CLI to its path" >&2
  exit 1
}

code_cli="$(find_code_cli)"
name="$(node -p 'require("./package.json").name')"
version="$(node -p 'require("./package.json").version')"
vsix="$here/$name-$version.vsix"

if [[ "${1:-}" != "--no-build" ]]; then
  npm run --silent package
fi
[[ -f "$vsix" ]] || { echo "error: $vsix not found; run without --no-build" >&2; exit 1; }

"$code_cli" --install-extension "$vsix" --force
echo "Installed $name $version. Reload VS Code windows to use it (Developer: Reload Window)."
