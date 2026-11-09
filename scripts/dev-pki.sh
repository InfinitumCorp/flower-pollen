#!/usr/bin/env bash
# Throwaway development/test PKI built with openssl. NOT for production; see deploy/pki/README.md.
# Usage: scripts/dev-pki.sh <out-dir> [callsign...]
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' # keep /CN=... intact under Git Bash on Windows

OUT=${1:?usage: dev-pki.sh <out-dir> [callsign...]}
shift
CALLSIGNS=("${@:-FLOWER-T1}")
mkdir -p "$OUT"
cd "$OUT"

cat > openssl.cnf <<'CNF'
[req]
distinguished_name = dn
[dn]
[ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
[server]
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
[client]
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = clientAuth
CNF

ec() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1"; }

# issue <name> <subject> <extension-section> [subjectAltName]
issue() {
  ec "$1-key.pem"
  openssl req -new -config openssl.cnf -key "$1-key.pem" -subj "$2" -out "$1.csr"
  cp openssl.cnf "$1.ext"
  if [ -n "${4:-}" ]; then printf 'subjectAltName = %s\n' "$4" >> "$1.ext"; fi
  openssl x509 -req -in "$1.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3650 \
    -extfile "$1.ext" -extensions "$3" -out "$1.pem"
  rm -f "$1.csr" "$1.ext"
}

ec ca-key.pem
openssl req -x509 -new -config openssl.cnf -extensions ca -key ca-key.pem \
  -subj "/O=Infinitum Dev/CN=Dev Fleet CA" -days 3650 -out ca.pem

issue server "/CN=localhost" server
for cs in "${CALLSIGNS[@]}"; do
  issue "$cs" "/CN=$cs" client "URI:urn:infinitum:flower:$cs"
done

# Valid-looking station cert that the CA never signed, for negative tests.
ec rogue-key.pem
openssl req -x509 -new -config openssl.cnf -key rogue-key.pem -subj "/CN=${CALLSIGNS[0]}" -days 3650 -out rogue.pem \
  -addext "subjectAltName=URI:urn:infinitum:flower:${CALLSIGNS[0]}" -addext "extendedKeyUsage=clientAuth"

rm -f openssl.cnf ca.srl
echo "dev PKI written to $OUT"
