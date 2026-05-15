#!/bin/bash
# Wrapper-skript för schemalagda körningar via launchd (eller cron).
# Sätter upp miljön, kör pipelinen, loggar resultat.
#
# Anropas av ~/Library/LaunchAgents/se.dagenssamhalle.leadagent.plist
# men kan också köras manuellt: ./scripts/run_pipeline.sh

set -euo pipefail

# Hoppa till projektroten (skriptet ligger i scripts/)
cd "$(dirname "$0")/.."

mkdir -p logs

TS="$(date '+%Y-%m-%d %H:%M:%S')"
echo "" >> logs/runs.log
echo "=== Run started $TS ===" >> logs/runs.log

# Ladda .env (för ANTHROPIC_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, DRIVE_FOLDER_ID)
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
else
    echo "VARNING: .env saknas — pipelinen kan misslyckas" >> logs/runs.log
fi

# uv finns vanligen i ~/.local/bin eller /opt/homebrew/bin. PATH för launchd är minimal.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Kör pipelinen. Default 3 dagars fönster räcker mellan måndag och torsdag.
if uv run python -m src.main run --days 3 >> logs/runs.log 2>&1; then
    echo "=== Run completed OK $(date '+%Y-%m-%d %H:%M:%S') ===" >> logs/runs.log
else
    EXIT=$?
    echo "=== Run FAILED with exit $EXIT $(date '+%Y-%m-%d %H:%M:%S') ===" >> logs/runs.log
    exit $EXIT
fi
