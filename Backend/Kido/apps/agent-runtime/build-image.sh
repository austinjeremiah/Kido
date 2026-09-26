#!/usr/bin/env bash
#
# Build the agent runtime image and produce the four artifacts a deployment needs to trust it:
#
#     the immutable digest, an SBOM, a build provenance attestation, and a vulnerability report.
#
# Two honest complications, both recorded rather than papered over.
#
# DRIFT D-1. BuildKit's in-toto attestations cannot be attached through the `docker` exporter unless
# the daemon uses the containerd image store, and this daemon uses overlay2 — `--sbom --provenance
# --load` builds an image with NO attestations and says nothing about it. So the attested build runs
# on a `docker-container` driver and exports an OCI archive, which really does contain in-toto SBOM
# and SLSA provenance statements; a second `--load` from the same cache produces the runnable image.
#
# TWO DIGESTS, AND THEY ARE NOT THE SAME THING. `docker image inspect .Id` is the CONFIG blob
# digest. The OCI image MANIFEST digest is what `image@sha256:...` means to a registry and to a
# runtime provider. Both are recorded, under names that say which is which, because pinning the
# wrong one would produce a manifest that appears to pin an image and cannot be used to pull it.
set -euo pipefail
cd "$(dirname "$0")/../.."

AGENT_ID="${AGENT_ID:-guardian}"
TAG="${TAG:-contextlock/agent-runtime:${AGENT_ID}}"
OUT="${OUT:-reports/group-e/evidence/image}"
BUILDER="${BUILDER:-contextlock-attest}"
BASE_DIGEST="${BASE_DIGEST:-sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5}"
SOURCE_COMMIT="$(git rev-parse HEAD)"
# The commit's own timestamp, not the wall clock.
#
# `date` here would put a different value in the image label on every build, which changes the
# config blob, which changes the digest — so "the same source produces the same digest" would be
# false, and a manifest that pins a digest could never be re-derived from the source it names.
CREATED="${CREATED:-$(git show -s --format=%cI "$SOURCE_COMMIT" | sed 's/+00:00/Z/')}"
BUILD_ID="${BUILD_ID:-bld_0001}"
BLUEPRINT_HASH="${BLUEPRINT_HASH:-sha256:$(printf 'blueprint-v3' | shasum -a 256 | cut -d' ' -f1)}"
STRATEGY_HASH="${STRATEGY_HASH:-sha256:$(printf 'strategy-v3' | shasum -a 256 | cut -d' ' -f1)}"

mkdir -p "$OUT"

ARGS=(
  --file apps/agent-runtime/Dockerfile
  --build-arg "BASE_DIGEST=${BASE_DIGEST}"
  --build-arg "SOURCE_COMMIT=${SOURCE_COMMIT}"
  --build-arg "BUILD_ID=${BUILD_ID}"
  --build-arg "BLUEPRINT_HASH=${BLUEPRINT_HASH}"
  --build-arg "STRATEGY_HASH=${STRATEGY_HASH}"
  --build-arg "AGENT_ID=${AGENT_ID}"
  --build-arg "CREATED=${CREATED}"
  --tag "$TAG"
  .
)

echo "── 1/4 attested build (OCI archive, docker-container driver) ──"
ATTESTED=1
docker buildx inspect "$BUILDER" >/dev/null 2>&1 || docker buildx create --name "$BUILDER" --driver docker-container --bootstrap >/dev/null
if ! docker buildx build --builder "$BUILDER" "${ARGS[@]}" \
      --provenance=mode=max --sbom=true \
      --output "type=oci,dest=${OUT}/agent-runtime.oci.tar" ; then
  echo "  attested OCI export failed" >&2
  ATTESTED=0
fi

echo "── 2/4 loading the runnable image ──"
docker buildx build "${ARGS[@]}" --load

CONFIG_DIGEST="$(docker image inspect "$TAG" --format '{{.Id}}')"

echo "── 3/4 extracting the manifest digest, SBOM and provenance ──"
MANIFEST_DIGEST=""
SBOM_METHOD="NONE"
if [ "$ATTESTED" = "1" ] && [ -f "${OUT}/agent-runtime.oci.tar" ]; then
  rm -rf "${OUT}/oci" && mkdir -p "${OUT}/oci"
  tar -xf "${OUT}/agent-runtime.oci.tar" -C "${OUT}/oci"
  MANIFEST_DIGEST="$(node -e '
    const fs=require("fs"), dir=process.argv[1], out=process.argv[2];
    const blob=(d)=>dir+"/blobs/"+d.replace(":","/");
    const read=(d)=>fs.readFileSync(blob(d),"utf8");
    const index=JSON.parse(fs.readFileSync(dir+"/index.json","utf8"));
    const top=JSON.parse(read(index.manifests[0].digest));
    const list = top.manifests || [index.manifests[0]];
    // The image manifest is the one with a real platform; the other is the attestation manifest,
    // which declares platform "unknown" and points back at it by digest.
    const image = list.find(m => m.platform && m.platform.architecture !== "unknown");
    const attest = list.find(m => (m.annotations||{})["vnd.docker.reference.type"] === "attestation-manifest");
    if (attest) {
      const am = JSON.parse(read(attest.digest));
      for (const l of am.layers) {
        const t = (l.annotations||{})["in-toto.io/predicate-type"] || "";
        // The OCI blobs are mode 0444, so a re-run would fail to overwrite. Write the bytes
        // rather than copying the file, and leave the result writable for the next build.
        const put = (name) => { fs.writeFileSync(out+"/"+name, fs.readFileSync(blob(l.digest))); fs.chmodSync(out+"/"+name, 0o644); };
        if (/spdx/i.test(t)) put("sbom.spdx.json");
        if (/provenance|slsa/i.test(t)) put("provenance.json");
      }
    }
    process.stdout.write(image ? image.digest : "");
  ' "${OUT}/oci" "$OUT")"
  [ -f "${OUT}/sbom.spdx.json" ] && SBOM_METHOD="BUILDKIT_INTOTO_OCI"
fi
if [ ! -f "${OUT}/sbom.spdx.json" ]; then
  if docker sbom "$TAG" --format spdx-json > "${OUT}/sbom.spdx.json" 2>/dev/null; then
    SBOM_METHOD="EXTERNAL_SYFT"
  else
    rm -f "${OUT}/sbom.spdx.json"
  fi
fi

echo "── 4/4 vulnerability scan ──"
#
# The gate in `image.ts` treats "the scanner did not run" as a FAILURE rather than as zero findings,
# which is the whole reason `ran` is a field. So this writes `ran: false` with a reason when no
# scanner is present; it does NOT write an empty findings list and let it read as clean.
#
# Only locally-installed scanners are used. Pulling one on demand would make the security gate
# depend on a network fetch of a third-party image at build time, which is a supply-chain decision
# and not one a build script should make on its own.
if command -v grype >/dev/null 2>&1; then
  grype "$TAG" -o json > "${OUT}/vuln.raw.json" 2>/dev/null || true
  SCANNER="grype"; SCANNER_VERSION="$(grype version 2>/dev/null | head -1)"; SCAN_RAN=true; SCAN_REASON=null
elif command -v trivy >/dev/null 2>&1; then
  trivy image --format json "$TAG" > "${OUT}/vuln.raw.json" 2>/dev/null || true
  SCANNER="trivy"; SCANNER_VERSION="$(trivy --version 2>/dev/null | head -1)"; SCAN_RAN=true; SCAN_REASON=null
else
  SCANNER="none"; SCANNER_VERSION="n/a"; SCAN_RAN=false
  SCAN_REASON='"No container vulnerability scanner (grype or trivy) is installed on this machine, and this script does not pull one. An unrun scan is not a clean scan: the promotion gate fails closed. See BLK-V2-VULN-SCANNER."'
fi

# A correctly-scoped SEPARATE artifact: the runtime image ships exactly one JS dependency, and npm
# can speak to that. It says nothing about the base image's OS packages, so it is recorded under its
# own name and is NOT allowed to stand in for the container scan above.
# `npm audit` runs at the workspace root, where the lockfile is; the runtime's own directory has
# none. This is the same audit the cumulative harness runs, recorded here so the image artifact
# states what it covers rather than leaving the reader to assume.
# `npm audit` exits non-zero when it finds anything, and `pipefail` would turn that into a build
# failure. The audit is recorded, not enforced, here — enforcement is the harness's job.
JS_AUDIT="$( { npm audit --json 2>/dev/null || true; } | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o={};try{o=JSON.parse(s).metadata?.vulnerabilities??{}}catch{}process.stdout.write(JSON.stringify(o))})')"
if [ -z "$JS_AUDIT" ]; then JS_AUDIT='{}'; fi

sha () { shasum -a 256 "$1" | cut -d' ' -f1; }
SBOM_DIGEST="null"; [ -f "${OUT}/sbom.spdx.json" ] && SBOM_DIGEST="\"sha256:$(sha "${OUT}/sbom.spdx.json")\""
PROV_DIGEST="null"; [ -f "${OUT}/provenance.json" ] && PROV_DIGEST="\"sha256:$(sha "${OUT}/provenance.json")\""
RUNS_AS="$(docker image inspect "$TAG" --format '{{.Config.User}}')"
RUNS_AS_ROOT=true; [ -n "$RUNS_AS" ] && [ "$RUNS_AS" != "0" ] && [ "$RUNS_AS" != "0:0" ] && [ "$RUNS_AS" != "root" ] && RUNS_AS_ROOT=false

cat > "${OUT}/runtime-image.json" <<JSON
{
  "_comment": "Produced by apps/agent-runtime/build-image.sh. imageManifestDigest is what a registry and a runtime provider mean by image@sha256:...; imageConfigDigest is what the local daemon reports as .Id. They are different digests of different objects and are never used interchangeably.",
  "agentId": "${AGENT_ID}",
  "tag": "${TAG}",
  "imageManifestDigest": "${MANIFEST_DIGEST}",
  "imageConfigDigest": "${CONFIG_DIGEST}",
  "baseImageDigest": "${BASE_DIGEST}",
  "platform": "$(docker image inspect "$TAG" --format '{{.Os}}/{{.Architecture}}')",
  "sbomDigest": ${SBOM_DIGEST},
  "sbomFormat": "spdx-json",
  "provenanceDigest": ${PROV_DIGEST},
  "provenanceFormat": "in-toto/slsa-provenance-v1",
  "attestationMethod": "${SBOM_METHOD}",
  "runsAsUser": "${RUNS_AS}",
  "runsAsRoot": ${RUNS_AS_ROOT},
  "labels": {
    "org.opencontainers.image.revision": "${SOURCE_COMMIT}",
    "org.opencontainers.image.created": "${CREATED}",
    "com.contextlock.build-id": "${BUILD_ID}",
    "com.contextlock.blueprint-hash": "${BLUEPRINT_HASH}",
    "com.contextlock.strategy-hash": "${STRATEGY_HASH}",
    "com.contextlock.agent-id": "${AGENT_ID}"
  },
  "vulnerabilityScan": {
    "scanner": "${SCANNER}",
    "scannerVersion": "${SCANNER_VERSION}",
    "ran": ${SCAN_RAN},
    "unavailableReason": ${SCAN_REASON:-null},
    "scope": "container image, including base-image OS packages"
  },
  "javascriptDependencyAudit": {
    "tool": "npm audit (workspace root)",
    "runtimeDependencies": ["zod@4.1.12"],
    "scope": "the WORKSPACE ROOT JavaScript dependency tree. It over-reports for this image, which ships only zod, and under-reports overall: it does not cover the base image's OS packages and does not substitute for the container scan above.",
    "vulnerabilities": ${JS_AUDIT}
  },
  "builtAt": "${CREATED}"
}
JSON

echo
echo "manifest digest : ${MANIFEST_DIGEST:-<none>}"
echo "config digest   : ${CONFIG_DIGEST}"
echo "base            : ${BASE_DIGEST}"
echo "sbom            : ${SBOM_METHOD}"
echo "user            : ${RUNS_AS} (root=${RUNS_AS_ROOT})"
echo "container scan  : ${SCANNER} (ran=${SCAN_RAN})"
echo "written to ${OUT}/runtime-image.json"
