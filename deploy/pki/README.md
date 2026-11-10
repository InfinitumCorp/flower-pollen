# Fleet device PKI

Flower™ stations authenticate to the backend with mTLS client certificates issued by an internal CA.
Production uses [cfssl](https://github.com/cloudflare/cfssl) (BSD-2-Clause), run as a separate tool on the CA host.
It is not bundled with or linked into this service, and using it implies no endorsement by Cloudflare.

```bash
# once: create the CA (keep ca-key.pem offline / in an HSM)
cfssl gencert -initca ca-csr.json | cfssljson -bare ca

# per station: SAN URI must be urn:infinitum:flower:<callsign>
cfssl gencert -ca ca.pem -ca-key ca-key.pem -config cfssl-config.json -profile flower-client \
  flower-csr.json | cfssljson -bare FLOWER-1
```

Then register the certificate (commander key), and point the server at the CA:

```bash
curl -X POST https://fleet.example/v1/device-certs -H "x-api-key: $COMMANDER" \
  -H 'content-type: application/json' --data "$(jq -Rs '{pem: .}' FLOWER-1.pem)"
```

Server env: `FP_TLS_CERT`, `FP_TLS_KEY` (server cert), `FP_CA_CERT` (this CA). Revoke with
`POST /v1/device-certs/<sha256 fingerprint>/revoke`; the station's open event streams close within one keep-alive.

`scripts/dev-pki.sh` builds an equivalent throwaway CA with openssl for local development and tests.
