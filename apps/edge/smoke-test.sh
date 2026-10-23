#!/usr/bin/env bash
# Starts the edge image between two stub upstreams and checks what it does with requests: routing,
# the headers core relies on, the upload limit and the answer while core is down. Runs in CI.
#   docker build -f apps/edge/Dockerfile -t book-to-audio-edge . && apps/edge/smoke-test.sh
set -euo pipefail

IMAGE=${1:-book-to-audio-edge}
STUB_IMAGE=node:24-alpine
NAME=edge-smoke-$$
PORT=${SMOKE_PORT:-18080}
BASE=http://localhost:$PORT
failures=0

# Answers every request with what it received, as JSON.
STUB='require("http").createServer((q, s) => {
  let bytes = 0;
  q.on("data", (c) => (bytes += c.length));
  q.on("end", () => {
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify({ app: process.env.APP, url: q.url, host: q.headers.host,
      origin: q.headers.origin ?? null, range: q.headers.range ?? null, bytes }));
  });
}).listen(3000)'

cleanup() {
  docker rm -f "$NAME-web" "$NAME-core" "$NAME-edge" "$NAME-bad" >/dev/null 2>&1 || true
  docker network rm "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

stub() {
  docker run -d --name "$NAME-$1" --network "$NAME" --network-alias "$1" -e APP="$1" \
    "$STUB_IMAGE" node -e "$STUB" >/dev/null
}

check() {
  if [[ "$3" == *"$2"* ]]; then
    echo "ok   $1"
  else
    echo "FAIL $1: expected $2, got $3"
    failures=$((failures + 1))
  fi
}

wait_for() {
  for _ in $(seq 1 60); do
    if [[ "$(curl -s "$BASE$1")" == *"$2"* ]]; then return 0; fi
    sleep 0.5
  done
  return 1
}

docker network create "$NAME" >/dev/null
stub web
stub core
docker run -d --name "$NAME-edge" --network "$NAME" -p "127.0.0.1:$PORT:8080" \
  -e MAX_UPLOAD_MB=1 "$IMAGE" >/dev/null
wait_for /api/ping '"app":"core"' || {
  docker logs "$NAME-edge"
  echo "FAIL the edge did not start"
  exit 1
}

check "/ goes to web" '"app":"web"' "$(curl -s "$BASE/books/1")"
check "/apix goes to web" '"app":"web"' "$(curl -s "$BASE/apix")"
check "/api goes to core" '"app":"core"' "$(curl -s "$BASE/api")"
check "the URL reaches core as sent" '"url":"/api/books/%65stimate?x=1"' \
  "$(curl -s "$BASE/api/books/%65stimate?x=1")"
check "Host passes through, port included" "\"host\":\"localhost:$PORT\"" "$(curl -s "$BASE/api/x")"
check "Origin passes through" '"origin":"https://evil.example"' \
  "$(curl -s -H 'Origin: https://evil.example' "$BASE/api/x")"
check "Range passes through" '"range":"bytes=0-9"' "$(curl -s -H 'Range: bytes=0-9' "$BASE/api/x")"

# MAX_UPLOAD_MB=1: nginx takes up to 2 MiB, so core's own limit is the one that answers.
check "a body under the limit reaches core" '"bytes":2000000' \
  "$(head -c 2000000 /dev/zero | curl -s --data-binary @- "$BASE/api/books")"
check "a body over the limit gets JSON 413" '"error":"too_large"' \
  "$(head -c 2200000 /dev/zero | curl -s -w ' %{http_code}' --data-binary @- "$BASE/api/books")"
check "... with status 413" ' 413' \
  "$(head -c 2200000 /dev/zero | curl -s -w ' %{http_code}' --data-binary @- "$BASE/api/books")"

docker stop "$NAME-core" >/dev/null
check "core down: JSON 502" '"error":"unreachable"' \
  "$(curl -s -w ' %{http_code}' "$BASE/api/health")"
check "... with status 502" ' 502' "$(curl -s -w ' %{http_code}' "$BASE/api/health")"
check "core down: pages still load" '"app":"web"' "$(curl -s "$BASE/")"
docker start "$NAME-core" >/dev/null
if wait_for /api/ping '"app":"core"'; then
  echo "ok   core found again after a restart"
else
  echo "FAIL core not found again after a restart"
  failures=$((failures + 1))
fi

docker run -d --name "$NAME-bad" -e MAX_UPLOAD_MB=08 "$IMAGE" >/dev/null
sleep 2
check "a bad MAX_UPLOAD_MB stops the edge" "false" \
  "$(docker inspect -f '{{.State.Running}}' "$NAME-bad")"

if ((failures > 0)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
