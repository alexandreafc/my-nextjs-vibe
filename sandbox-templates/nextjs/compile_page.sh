#!/bin/bash

LOG_FILE="/tmp/nextjs-dev.log"

function ping_server() {
	counter=0
	response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000")
	while [[ ${response} -ne 200 ]]; do
	  let counter++
	  if (( counter % 20 == 0 )); then
        echo "[compile_page] Waiting for server on port 3000... (attempt $counter)"
        sleep 0.1
      fi
	  response=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:3000")
	done
	echo "[compile_page] Server is up! HTTP $response on port 3000"
}

echo "[compile_page] Starting Next.js dev server (turbopack, host 0.0.0.0)..." | tee -a "$LOG_FILE"

ping_server &

while true; do
  cd /home/user && NODE_OPTIONS="--max-old-space-size=1536" npx next dev --turbopack -H 0.0.0.0 2>&1 | tee -a "$LOG_FILE"
  EXIT_CODE=$?
  echo "[compile_page] Next.js dev server exited with code $EXIT_CODE — restarting in 2s..." | tee -a "$LOG_FILE"
  sleep 2
done
