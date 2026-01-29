#!/bin/bash
set -e

# Optional: forward localhost ports to the docker-dind container (e.g., 3000)
if [ -n "$OPENCODE_DIND_FORWARD_PORTS" ]; then
    if command -v socat >/dev/null 2>&1; then
        IFS=',' read -ra FORWARD_PORTS <<< "$OPENCODE_DIND_FORWARD_PORTS"
        for port in "${FORWARD_PORTS[@]}"; do
            port=$(echo "$port" | xargs)
            if [ -n "$port" ]; then
                echo "Forwarding localhost:${port} -> docker:${port}"
                socat TCP-LISTEN:${port},fork,reuseaddr TCP:docker:${port} >/tmp/socat-${port}.log 2>&1 &
            fi
        done
    else
        echo "socat not installed; skipping localhost port forwarding"
    fi
fi

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
