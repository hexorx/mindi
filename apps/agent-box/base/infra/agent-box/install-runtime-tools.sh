#!/bin/sh
# Optional vendor tools belong to the persisted home, never an image layer.
set -eu
umask 077
root="$HOME/.local/share/mindi-tools"
bin="$HOME/.local/bin"
inputs="${MINDI_RUNTIME_INPUTS:-/opt/runtime-tools}"
chrome_version=154.0.8037.97
chrome_sha=a4edbe95e9b01db6c9b97d7a1323121eda18362b5620df06abac1b59bee80053
mkdir -p "$root" "$bin"

install_claude() {
    lock_sha=$(sha256sum "$inputs/package-lock.json" | cut -d ' ' -f 1)
    target="$root/npm-$lock_sha"
    if [ ! -f "$target/.complete" ] || [ ! -x "$target/node_modules/.bin/claude" ] ||
       [ ! -x "$target/node_modules/.bin/claude-agent-acp" ] ||
       [ "$("$target/node_modules/.bin/claude" --version 2>/dev/null)" != "2.1.266 (Claude Code)" ]; then
        stage=$(mktemp -d "$root/npm-stage.XXXXXX")
        trap 'rm -rf "$stage"' EXIT
        trap 'exit 1' HUP INT TERM
        cp "$inputs/package.json" "$inputs/package-lock.json" "$stage/"
        npm ci --prefix "$stage" --cache "$root/npm-cache" --omit=dev --ignore-scripts --no-audit --no-fund
        # Only Claude needs a postinstall: link the lock-pinned native optional package.
        node "$stage/node_modules/@anthropic-ai/claude-code/install.cjs"
        case "$("$stage/node_modules/.bin/claude" --version)" in
            '2.1.266 '*) ;;
            *) echo 'runtime tools: unexpected Claude version' >&2; exit 1 ;;
        esac
        touch "$stage/.complete"
        # A completed destination is immutable. Failed attempts never become it.
        if [ -e "$target" ]; then
            mv "$target" "$(mktemp -d "$root/npm-previous.XXXXXX")/install"
        fi
        mv -T "$stage" "$target"
        echo 'runtime tools: installed Claude 2.1.266 and ACP 0.75.1'
    else
        echo 'runtime tools: Claude 2.1.266 and ACP 0.75.1 already installed; skipping'
    fi
    ln -sfn "$target/node_modules/.bin/claude" "$bin/claude"
    ln -sfn "$target/node_modules/.bin/claude-agent-acp" "$bin/claude-agent-acp"
}

install_chrome() {
    [ "$(dpkg --print-architecture)" = amd64 ] || {
        echo 'runtime tools: pinned Chrome requires amd64' >&2; exit 1;
    }
    target="$root/chrome-$chrome_version-$chrome_sha"
    if [ ! -f "$target/.complete" ] || [ ! -x "$target/opt/google/chrome/chrome" ] ||
       [ "$("$target/opt/google/chrome/chrome" --version 2>/dev/null)" != "Google Chrome $chrome_version " ]; then
        stage=$(mktemp -d "$root/chrome-stage.XXXXXX")
        trap 'rm -rf "$stage"' EXIT
        trap 'exit 1' HUP INT TERM
        curl --fail --silent --show-error --location --connect-timeout 10 --max-time 90 \
            "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${chrome_version}-1_amd64.deb" \
            -o "$stage/package.deb"
        printf '%s  %s\n' "$chrome_sha" "$stage/package.deb" | sha256sum -c -
        mkdir "$stage/unpacked"
        dpkg-deb -x "$stage/package.deb" "$stage/unpacked"
        [ "$("$stage/unpacked/opt/google/chrome/chrome" --version)" = "Google Chrome $chrome_version " ] || {
            echo 'runtime tools: unexpected Chrome version' >&2; exit 1;
        }
        touch "$stage/unpacked/.complete"
        if [ -e "$target" ]; then
            mv "$target" "$(mktemp -d "$root/chrome-previous.XXXXXX")/install"
        fi
        mv -T "$stage/unpacked" "$target"
        echo "runtime tools: installed Chrome $chrome_version"
    else
        echo "runtime tools: Chrome $chrome_version already installed; skipping"
    fi
    ln -sfn "$target" "$root/chrome"
    ln -sfn /opt/runtime-browser-launcher "$bin/google-chrome"
}

case "${1:-}" in
    --claude) install_claude; exit ;;
    --chrome) install_chrome; exit ;;
esac
# Serialize starts sharing a home, and bound all downloads even when offline.
exec 9>"$root/install.lock"
flock -w 5 9 || { echo 'runtime tools: another installer is active; continuing' >&2; exit 0; }
for tool in claude chrome; do
    timeout --kill-after=5 120 sh "$0" "--$tool" ||
        echo "runtime tools: $tool install failed; continuing startup (retry next start)" >&2
done
