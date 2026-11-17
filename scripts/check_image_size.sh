#!/usr/bin/env bash
set -euo pipefail

LIMIT=1200000000
IMAGE="${1:-necrolegacy-api:latest}"

size=$(docker image inspect "$IMAGE" --format '{{.Size}}')
echo "image $IMAGE size: ${size} bytes (limit ${LIMIT})"
if [ "$size" -ge "$LIMIT" ]; then
  echo "FAIL: image is ${size} bytes, at or above ${LIMIT}" >&2
  exit 1
fi
