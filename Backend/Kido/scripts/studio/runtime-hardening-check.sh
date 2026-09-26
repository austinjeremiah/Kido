#!/usr/bin/env bash
#
# Run the real runtime image, with the real hardening flags, and check the properties on the
# container that is actually running.
#
# Everything here is a live observation. A unit test can prove that `dockerArgs` emits `--read-only`;
# only this can prove that a process inside the container is refused a write. The two are different
# claims and the second is the one users care about.
#
# Writes reports/group-e/evidence/runtime-hardening.json
set -uo pipefail
cd "$(dirname "$0")/../.."

TAG="${TAG:-contextlock/agent-runtime:guardian}"
OUT="reports/group-e/evidence/runtime-hardening.json"
NAME="contextlock-harden-$$"
VOLUME="contextlock-harden-vol-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1; docker volume rm -f "$VOLUME" >/dev/null 2>&1' EXIT

PASS=0; FAIL=0
RESULTS=()
check () { # name expected actual
  local name="$1" expected="$2" actual="$3" ok
  if [ "$expected" = "$actual" ]; then ok=true; PASS=$((PASS+1)); else ok=false; FAIL=$((FAIL+1)); fi
  RESULTS+=("$(printf '{"check":"%s","expected":%s,"observed":%s,"pass":%s}' \
      "$name" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$expected")" \
      "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$actual")" "$ok")")
  printf '  %-52s %s\n' "$name" "$([ "$ok" = true ] && printf '\033[32mPASS\033[0m' || printf "\033[31mFAIL (expected '%s', got '%s')\033[0m" "$expected" "$actual")"
}

DIGEST_RECORD="reports/group-e/evidence/image/runtime-image.json"
IMAGE_DIGEST="$(node -e 'try{console.log(require("./'"$DIGEST_RECORD"'").imageManifestDigest)}catch{console.log("")}' 2>/dev/null)"
[ -z "$IMAGE_DIGEST" ] && IMAGE_DIGEST="sha256:$(printf 'unknown' | shasum -a 256 | cut -d' ' -f1)"

printf '\n\033[1m── the runtime refuses to start carrying a credential ──\033[0m\n'
# The most important one, and the first: a container launched WITH a wallet key must not come up.
REFUSE_OUT="$(docker run --rm --user 10001:10001 --read-only \
  --security-opt no-new-privileges:true --cap-drop ALL --pids-limit 128 --memory 512m --cpus 0.5 \
  --tmpfs /tmp/contextlock:rw,noexec,nosuid,mode=1777,size=64m \
  -e AGENT_PRIVATE_KEY=0x1111111111111111111111111111111111111111111111111111111111111111 \
  -e CONTEXTLOCK_DEPLOYMENT_ID=dep_1 -e CONTEXTLOCK_AGENT_ID=guardian \
  "$TAG" 2>&1)"
REFUSE_CODE=$?
check "startup refused when a wallet key is present" "78" "$REFUSE_CODE"
echo "$REFUSE_OUT" | grep -q "RUNTIME-FORBIDDEN-CREDENTIAL-PRESENT" && NAMED=yes || NAMED=no
check "the refusal names the credential class" "yes" "$NAMED"
echo "$REFUSE_OUT" | grep -q "0x1111111111111111" && LEAKED=yes || LEAKED=no
check "the refusal does NOT quote the secret value" "no" "$LEAKED"

for K in OPENAI_API_KEY CRE_API_KEY CAPABILITY_ISSUER_PRIVATE_KEY AWS_SECRET_ACCESS_KEY LEDGER_SEED; do
  docker run --rm --user 10001:10001 --read-only -e "$K=some-value-here" \
    -e CONTEXTLOCK_DEPLOYMENT_ID=d -e CONTEXTLOCK_AGENT_ID=a "$TAG" >/dev/null 2>&1
  check "startup refused when $K is present" "78" "$?"
done

printf '\n\033[1m── a correctly-configured runtime comes up ──\033[0m\n'
# The token reaches the container through a read-only named volume, seeded on stdin by a throwaway
# container. `docker cp` cannot do this: the daemon refuses it into a read-only rootfs, which is
# what an earlier version of this script discovered.
docker volume create "$VOLUME" >/dev/null
printf 'a-scoped-runtime-token-that-authenticates-nothing-financial' | \
  docker run --rm -i --user 0:0 -v "$VOLUME:/seed" --entrypoint sh "$TAG" \
    -c 'cat > /seed/runtime-token && chown 10001:10001 /seed/runtime-token && chmod 0400 /seed/runtime-token' >/dev/null

docker create --name "$NAME" \
  --user 10001:10001 \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cpus 0.5 --memory 512m --pids-limit 128 \
  --restart on-failure:3 \
  --tmpfs /tmp/contextlock:rw,noexec,nosuid,mode=1777,size=64m \
  --volume "$VOLUME:/run/contextlock:ro" \
  -p 18080:8080 \
  -e CONTEXTLOCK_DEPLOYMENT_ID=dep_live_0001 \
  -e CONTEXTLOCK_AGENT_ID=guardian \
  -e CONTEXTLOCK_IMAGE_DIGEST="$IMAGE_DIGEST" \
  -e CONTEXTLOCK_BLUEPRINT_HASH="sha256:$(printf 'blueprint-v3' | shasum -a 256 | cut -d' ' -f1)" \
  -e CONTEXTLOCK_STRATEGY_HASH="sha256:$(printf 'strategy-v3' | shasum -a 256 | cut -d' ' -f1)" \
  -e CONTEXTLOCK_MODEL_GATEWAY_URL=https://gateway.contextlock.test/model \
  -e CONTEXTLOCK_ADAPTER_BROKER_URL=https://gateway.contextlock.test/adapter \
  -e CONTEXTLOCK_BROKER_URL=https://gateway.contextlock.test/contextlock \
  -e CONTEXTLOCK_TELEMETRY_URL=https://gateway.contextlock.test/telemetry \
  -e CONTEXTLOCK_RUNTIME_TOKEN_PATH=/run/contextlock/runtime-token \
  "$TAG" >/dev/null

docker start "$NAME" >/dev/null
sleep 4

RUNNING="$(docker inspect "$NAME" --format '{{.State.Running}}')"
check "the container is running" "true" "$RUNNING"

printf '\n\033[1m── RUN-003..006 observed on the running container ──\033[0m\n'
check "RUN-003 runs as a non-root uid"   "10001" "$(docker exec "$NAME" id -u 2>/dev/null)"
check "RUN-003 runs as a non-root gid"   "10001" "$(docker exec "$NAME" id -g 2>/dev/null)"
check "RUN-004 root filesystem read-only (config)" "true" "$(docker inspect "$NAME" --format '{{.HostConfig.ReadonlyRootfs}}')"
docker exec "$NAME" sh -c 'echo x > /app/pwned' >/dev/null 2>&1 && W=written || W=refused
check "RUN-004 a write to /app is refused" "refused" "$W"
docker exec "$NAME" sh -c 'echo x > /etc/pwned' >/dev/null 2>&1 && W2=written || W2=refused
check "RUN-004 a write to /etc is refused" "refused" "$W2"
docker exec "$NAME" sh -c 'echo x > /tmp/contextlock/scratch' >/dev/null 2>&1 && W3=written || W3=refused
check "RUN-004 the explicit tmpfs IS writable" "written" "$W3"
check "RUN-005 privileged mode is off"   "false" "$(docker inspect "$NAME" --format '{{.HostConfig.Privileged}}')"
check "RUN-005 no-new-privileges is set" "true"  "$(docker inspect "$NAME" --format '{{range .HostConfig.SecurityOpt}}{{if eq . "no-new-privileges:true"}}true{{end}}{{end}}')"
check "RUN-005 all capabilities dropped" "[ALL]" "$(docker inspect "$NAME" --format '{{.HostConfig.CapDrop}}')"
check "RUN-005 no capabilities added"    "[]"    "$(docker inspect "$NAME" --format '{{.HostConfig.CapAdd}}')"
docker exec "$NAME" sh -c 'test -S /var/run/docker.sock -o -S /run/docker.sock' >/dev/null 2>&1 && S=present || S=absent
check "RUN-006 the Docker socket is absent" "absent" "$S"
# One mount: the read-only credential volume. It is a named volume, not a host path.
check "RUN-006 exactly one mount, the token volume" "1" "$(docker inspect "$NAME" --format '{{len .Mounts}}')"
check "RUN-006 that mount is a volume, not a bind"  "volume" "$(docker inspect "$NAME" --format '{{range .Mounts}}{{.Type}}{{end}}')"
check "RUN-006 the token volume is read-only"       "false"  "$(docker inspect "$NAME" --format '{{range .Mounts}}{{.RW}}{{end}}')"
docker exec "$NAME" sh -c 'echo x > /run/contextlock/runtime-token' >/dev/null 2>&1 && TW=written || TW=refused
check "the runtime cannot overwrite its own token"  "refused" "$TW"

printf '\n\033[1m── RUN-028 resource limits, observed ──\033[0m\n'
check "memory limit is 512MiB"  "536870912" "$(docker inspect "$NAME" --format '{{.HostConfig.Memory}}')"
check "PID limit is 128"        "128"       "$(docker inspect "$NAME" --format '{{.HostConfig.PidsLimit}}')"
check "CPU quota is set"        "true"      "$([ "$(docker inspect "$NAME" --format '{{.HostConfig.NanoCpus}}')" -gt 0 ] && echo true || echo false)"
check "network is not host"     "false"     "$(docker inspect "$NAME" --format '{{eq .HostConfig.NetworkMode "host"}}')"

printf '\n\033[1m── RUN-007 no credential is in the running container ──\033[0m\n'
ENVDUMP="$(docker inspect "$NAME" --format '{{json .Config.Env}}')"
for K in OPENAI_API_KEY CRE_API_KEY AGENT_PRIVATE_KEY CAPABILITY_ISSUER_PRIVATE_KEY AWS_SECRET_ACCESS_KEY DEPLOYER_PRIVATE_KEY; do
  echo "$ENVDUMP" | grep -q "$K" && P=present || P=absent
  check "$K absent from the container environment" "absent" "$P"
done
# The token is a file, so it must NOT be visible in `docker inspect`.
echo "$ENVDUMP" | grep -q "a-scoped-runtime-token" && TP=present || TP=absent
check "the runtime token is not in docker inspect" "absent" "$TP"
docker exec "$NAME" test -f /run/contextlock/runtime-token >/dev/null 2>&1 && TF=present || TF=absent
check "the runtime token IS present as a file" "present" "$TF"
docker exec "$NAME" test -f /root/.cre/cre.yaml >/dev/null 2>&1 && C=present || C=absent
check "no CRE session file in the image" "absent" "$C"
docker exec "$NAME" test -f /app/.env >/dev/null 2>&1 && E=present || E=absent
check "no .env in the image" "absent" "$E"

printf '\n\033[1m── health, and what it is careful not to claim ──\033[0m\n'
HEALTH="$(curl -s --max-time 5 http://127.0.0.1:18080/health 2>/dev/null)"
check "the health endpoint answers" "true" "$([ -n "$HEALTH" ] && echo true || echo false)"
echo "$HEALTH" | grep -q "says nothing about financial authority" && N=yes || N=no
check "health states it is not financial authority" "yes" "$N"
REPORTED_DIGEST="$(echo "$HEALTH" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).imageDigest)}catch{console.log("")}})')"
check "health reports the pinned image digest" "$IMAGE_DIGEST" "$REPORTED_DIGEST"
# A health endpoint is the most-scraped surface a container has; it must leak nothing.
echo "$HEALTH" | grep -qE "token|GATEWAY_URL|https://" && L=leaks || L=clean
check "health leaks no configuration or token" "clean" "$L"

printf '\n\033[1m── stopping the runtime is not a security kill ──\033[0m\n'
STOPLOG="$(docker stop "$NAME" 2>&1; docker logs "$NAME" 2>&1 | tail -5)"
echo "$STOPLOG" | grep -q "does NOT disable the ContextLock policy" && K=yes || K=no
check "the stop log says it does not disable policy" "yes" "$K"

mkdir -p "$(dirname "$OUT")"
{
  printf '{\n  "_comment": "Live observations on a running container from the built runtime image. Every value was read from Docker or from the process inside the container; none is a fixture.",\n'
  printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "image": "%s",\n  "imageDigest": "%s",\n' "$TAG" "$IMAGE_DIGEST"
  printf '  "passed": %d,\n  "failed": %d,\n' "$PASS" "$FAIL"
  printf '  "checks": [\n'
  for i in "${!RESULTS[@]}"; do
    printf '    %s%s\n' "${RESULTS[$i]}" "$([ $i -lt $((${#RESULTS[@]}-1)) ] && echo ,)"
  done
  printf '  ]\n}\n'
} > "$OUT"

printf '\n\033[1m%d passed, %d failed\033[0m — written to %s\n' "$PASS" "$FAIL" "$OUT"
[ "$FAIL" -eq 0 ] || exit 1
