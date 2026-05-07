"""Azure Entra ID OIDC mock.

Schema source: Microsoft Identity Platform OIDC discovery + token endpoint v2.0.
- GET /{tenant}/v2.0/.well-known/openid-configuration
- GET /{tenant}/discovery/v2.0/keys
- GET /{tenant}/oauth2/v2.0/authorize  -> 302 redirect with code
- POST /{tenant}/oauth2/v2.0/token     -> issues mock id_token + access_token

Default tenant: bookflow-mock-tenant (override via Authorization or path).
Signing key: dev RSA-2048 generated on startup (kid stable per pod lifecycle).
"""
from __future__ import annotations

import time
import uuid
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Form, HTTPException, Query
from fastapi.responses import JSONResponse, RedirectResponse

app = FastAPI(title="azure-entra-mock", version="0.1.0")

# ---- crypto: dev RSA key (regenerated on each pod start) ----------------
_PRIVATE_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PUBLIC_NUMBERS = _PRIVATE_KEY.public_key().public_numbers()
_KID = uuid.uuid4().hex[:16]


def _b64url_uint(value: int) -> str:
    import base64

    raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@app.get("/{tenant}/v2.0/.well-known/openid-configuration")
def openid_config(tenant: str) -> dict[str, Any]:
    base = f"http://azure-entra-mock.stubs.svc.cluster.local/{tenant}"
    return {
        "issuer": f"{base}/v2.0",
        "authorization_endpoint": f"{base}/oauth2/v2.0/authorize",
        "token_endpoint": f"{base}/oauth2/v2.0/token",
        "jwks_uri": f"{base}/discovery/v2.0/keys",
        "response_types_supported": ["code", "id_token", "code id_token"],
        "subject_types_supported": ["pairwise"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "scopes_supported": ["openid", "profile", "email", "offline_access"],
        "token_endpoint_auth_methods_supported": [
            "client_secret_post",
            "client_secret_basic",
        ],
        "claims_supported": [
            "sub", "iss", "aud", "exp", "iat", "name", "email", "oid", "tid", "roles",
        ],
    }


@app.get("/{tenant}/discovery/v2.0/keys")
def jwks(tenant: str) -> dict[str, Any]:
    return {
        "keys": [
            {
                "kty": "RSA",
                "use": "sig",
                "kid": _KID,
                "alg": "RS256",
                "n": _b64url_uint(_PUBLIC_NUMBERS.n),
                "e": _b64url_uint(_PUBLIC_NUMBERS.e),
            }
        ]
    }


@app.get("/{tenant}/oauth2/v2.0/authorize")
def authorize(
    tenant: str,
    redirect_uri: str = Query(...),
    state: str | None = Query(default=None),
    response_type: str = Query("code"),
    client_id: str = Query(...),
):
    """Skip user interaction; immediately redirect with mock auth code."""
    code = f"mock-code-{uuid.uuid4().hex}"
    sep = "&" if "?" in redirect_uri else "?"
    target = f"{redirect_uri}{sep}code={code}"
    if state:
        target += f"&state={state}"
    return RedirectResponse(target, status_code=302)


_USERS = {
    # Mirrors RDS users seed (see infra/aws/20-data-persistent/seed-data/users.csv)
    "hq-admin@bookflow.local": {
        "oid": "00000000-0000-0000-0000-000000000001",
        "name": "HQ Admin",
        "roles": ["hq-admin"],
    },
    "wh1-manager@bookflow.local": {
        "oid": str(uuid.uuid5(uuid.NAMESPACE_OID, "wh-manager-1")),
        "name": "WH1 Manager",
        "roles": ["wh-manager"],
    },
    "wh2-manager@bookflow.local": {
        "oid": str(uuid.uuid5(uuid.NAMESPACE_OID, "wh-manager-2")),
        "name": "WH2 Manager",
        "roles": ["wh-manager"],
    },
}


def _make_id_token(tenant: str, client_id: str, email: str) -> str:
    user = _USERS.get(email) or {
        "oid": str(uuid.uuid5(uuid.NAMESPACE_OID, email)),
        "name": email.split("@")[0],
        "roles": ["branch-clerk"],
    }
    now = int(time.time())
    payload = {
        "iss": f"http://azure-entra-mock.stubs.svc.cluster.local/{tenant}/v2.0",
        "aud": client_id,
        "exp": now + 3600,
        "iat": now,
        "nbf": now,
        "sub": user["oid"],
        "oid": user["oid"],
        "tid": tenant,
        "name": user["name"],
        "email": email,
        "preferred_username": email,
        "roles": user["roles"],
    }
    pem = _PRIVATE_KEY.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return jwt.encode(payload, pem, algorithm="RS256", headers={"kid": _KID})


@app.post("/{tenant}/oauth2/v2.0/token")
def token(
    tenant: str,
    grant_type: str = Form(...),
    client_id: str = Form(...),
    code: str | None = Form(default=None),
    refresh_token: str | None = Form(default=None),
    redirect_uri: str | None = Form(default=None),
    client_secret: str | None = Form(default=None),
    scope: str | None = Form(default="openid profile email"),
    username: str | None = Form(default="hq-admin@bookflow.local"),
):
    if grant_type not in ("authorization_code", "refresh_token", "client_credentials", "password"):
        raise HTTPException(status_code=400, detail={"error": "unsupported_grant_type"})

    email = username or "hq-admin@bookflow.local"
    id_token = _make_id_token(tenant, client_id, email)
    access_token = id_token  # same payload in mock
    return JSONResponse(
        {
            "token_type": "Bearer",
            "scope": scope,
            "expires_in": 3600,
            "ext_expires_in": 3600,
            "access_token": access_token,
            "id_token": id_token,
            "refresh_token": f"mock-refresh-{uuid.uuid4().hex}",
        }
    )


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "kid": _KID}
