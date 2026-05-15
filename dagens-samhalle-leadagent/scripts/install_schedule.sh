#!/bin/bash
# Installerar launchd-jobbet som kör leadagent-pipelinen måndag + torsdag 07:00.
#
# Användning:
#   ./scripts/install_schedule.sh
#
# Auto-detekterar projektsökvägen, skriver in den i plisten, kopierar till
# ~/Library/LaunchAgents/, och laddar jobbet med launchctl. Idempotent —
# kan köras igen vid behov (ersätter befintlig installation).
#
# Avinstallera:
#   ./scripts/uninstall_schedule.sh

set -euo pipefail

LABEL="se.dagenssamhalle.leadagent"
PLIST_TEMPLATE_NAME="$LABEL.plist"

# Sökvägar
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_PLIST="$SCRIPT_DIR/$PLIST_TEMPLATE_NAME"
TARGET_PLIST="$HOME/Library/LaunchAgents/$PLIST_TEMPLATE_NAME"

echo "→ Projektsökväg:   $PROJECT_ROOT"
echo "→ Plist-källa:     $SOURCE_PLIST"
echo "→ Plist-mål:       $TARGET_PLIST"
echo

# Sanity-checks
if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "FEL: detta skript är skrivet för macOS (launchd). Du kör $(uname -s)."
    exit 1
fi
if [[ ! -f "$SOURCE_PLIST" ]]; then
    echo "FEL: hittar inte $SOURCE_PLIST"
    exit 1
fi
if [[ ! -x "$SCRIPT_DIR/run_pipeline.sh" ]]; then
    echo "FEL: $SCRIPT_DIR/run_pipeline.sh saknas eller är inte exekverbar."
    echo "     Kör: chmod +x $SCRIPT_DIR/run_pipeline.sh"
    exit 1
fi
if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
    echo "VARNING: $PROJECT_ROOT/.env saknas — pipelinen kommer misslyckas"
    echo "         förrän du kopierar .env.example och fyller i nycklarna."
    echo
fi

# Avlasta befintlig installation om sådan finns
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "→ Jobbet är redan laddat. Avlastar för att kunna ersätta..."
    launchctl bootout "gui/$(id -u)/$LABEL" || true
fi

# Skapa logs-katalog
mkdir -p "$PROJECT_ROOT/logs"

# Generera plist med faktiska sökvägar
mkdir -p "$(dirname "$TARGET_PLIST")"
sed "s|/Users/CHANGEME/path/to/dagens-samhalle-leadagent|$PROJECT_ROOT|g" \
    "$SOURCE_PLIST" > "$TARGET_PLIST"

# Validera plist-syntax
if ! plutil -lint "$TARGET_PLIST" >/dev/null; then
    echo "FEL: plisten är inte giltig efter substitution. Raderar."
    rm -f "$TARGET_PLIST"
    exit 1
fi

echo "→ Plist skriven och validerad."

# Ladda jobbet
launchctl bootstrap "gui/$(id -u)" "$TARGET_PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "→ Jobb laddat med launchctl."
echo

# Visa nästa körning
NEXT_FIRE="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'next fire' | head -1 || true)"
if [[ -n "$NEXT_FIRE" ]]; then
    echo "✓ Installation klar. $NEXT_FIRE"
else
    echo "✓ Installation klar."
fi

cat <<EOF

Nästa schemalagda körning är måndag eller torsdag kl 07:00, vilkendera
som kommer först. Du kan kicka igång en testkörning direkt med:

    launchctl kickstart -k gui/\$(id -u)/$LABEL
    tail -f logs/runs.log

För att avinstallera senare:

    ./scripts/uninstall_schedule.sh
EOF
