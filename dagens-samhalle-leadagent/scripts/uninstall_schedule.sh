#!/bin/bash
# Avinstallerar launchd-jobbet för leadagent-pipelinen.

set -euo pipefail

LABEL="se.dagenssamhalle.leadagent"
TARGET_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL" || true
    echo "→ Jobbet avlastat."
else
    echo "→ Inget jobb laddat med label $LABEL."
fi

if [[ -f "$TARGET_PLIST" ]]; then
    rm -f "$TARGET_PLIST"
    echo "→ Plisten raderad från ~/Library/LaunchAgents/."
fi

echo "✓ Klart. Loggar och utdata under projektet är orörda."
