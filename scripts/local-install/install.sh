# Installs plugins/watchdog as the working tree has it, through the local marketplace happyonigiri-plugins.
# Run by `make install`.
set -eu

config="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
marketplace="$config/local-marketplaces/happyonigiri"
plugin="watchdog@happyonigiri-plugins"

mkdir -p "$marketplace/.claude-plugin"
cp scripts/local-install/marketplace.json "$marketplace/.claude-plugin/marketplace.json"
rsync -a --delete plugins/watchdog/ "$marketplace/watchdog/"

if ! claude plugin marketplace list | grep -q 'happyonigiri-plugins$'; then
  claude plugin marketplace add "$marketplace"
fi
claude plugin marketplace update happyonigiri-plugins

# `update` skips a build whose version did not change, so the plugin goes in again. `uninstall` drops the options
# set in /config, so they are read before it and saved again after the install.
options=$(node scripts/local-install/options.mjs "$config/settings.json" "$plugin")
if claude plugin list | grep -q "$plugin\$"; then
  claude plugin uninstall --keep-data "$plugin"
fi
claude plugin install "$plugin"
if [ "$options" != "{}" ]; then
  echo "$options" | claude plugin configure --values-stdin "$plugin"
fi
echo "Installed $plugin from $(git rev-parse --abbrev-ref HEAD) ($(git rev-parse --short HEAD)). Restart Claude Code to apply."
