#!/bin/sh
set -e

# Fix ownership of data directory for users upgrading from root-based images.
if [ "$(stat -c '%u' "$KRSS_DATA_DIR" 2>/dev/null)" != "$(id -u krss)" ]; then
    chown -R krss:krss "$KRSS_DATA_DIR"
fi

exec su-exec krss "$@"
