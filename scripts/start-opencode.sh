#!/bin/bash
set -e

# Build the opencode web command with hostname
CMD_ARGS=("opencode" "--log-level" "DEBUG" "web" "--hostname=${OPENCODE_WEB_HOST:-0.0.0.0}")

# Add CORS flags if OPENCODE_WEB_CORS is set
if [ -n "$OPENCODE_WEB_CORS" ]; then
    # Split comma-separated CORS URLs and add --cors flag for each
    IFS=',' read -ra CORS_URLS <<< "$OPENCODE_WEB_CORS"
    for url in "${CORS_URLS[@]}"; do
        # Trim whitespace from URL
        url=$(echo "$url" | xargs)
        if [ -n "$url" ]; then
            CMD_ARGS+=("--cors=$url")
        fi
    done
fi

# Execute the command
echo "Executing command: ${CMD_ARGS[@]}"
exec "${CMD_ARGS[@]}"
