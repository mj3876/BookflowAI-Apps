"""OIDC authorization code flow routes.

Flow:
  /auth/login   → 302 to Entra authorize URL
  /auth/callback → exchange code for tokens · validate id_token · upsert RDS user · issue BookFlow JWT · set cookie · redirect to /
  /auth/whoami  → JSON of current user (verify cookie)
  /auth/logout  → clear cookie · redirect to Entra end_session
"""
import logging
import secrets
import urllib.parse

import httpx
import jwt as pyjwt
from authlib.jose import JsonWebKey, jwt as authlib_jwt
from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse

from .. import db, jwt_issuer
from ..settings import settings

log = logging.getLogger(__name__)
router = APIRouter()

OIDC_DISCOVERY = f"https://login.microsoftonline.com/{{tenant}}/v2.0/.well-known/openid-configuration"
COOKIE_NAME = "bookflow_session"
STATE_COOKIE = "bookflow_oidc_state"

_oidc_meta_cache: dict | None = None
_jwks_cache: JsonWebKey | None = None


async def _get_oidc_meta() -> dict:
    global _oidc_meta_cache
    if _oidc_meta_cache:
        return _oidc_meta_cache
    url = OIDC_DISCOVERY.format(tenant=settings.entra_tenant_id)
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(url)
        r.raise_for_status()
        _oidc_meta_cache = r.json()
    return _oidc_meta_cache


async def _get_jwks() -> JsonWebKey:
    global _jwks_cache
    if _jwks_cache:
        return _jwks_cache
    meta = await _get_oidc_meta()
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(meta["jwks_uri"])
        r.raise_for_status()
        _jwks_cache = JsonWebKey.import_key_set(r.json())
    return _jwks_cache


@router.get("/auth/login")
async def login(request: Request):
    meta = await _get_oidc_meta()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_urlsafe(24)
    redirect_uri = f"{settings.public_base_url}{settings.redirect_path}"
    params = {
        "client_id": settings.entra_client_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "response_mode": "query",
        "scope": "openid profile email",
        "state": state,
        "nonce": nonce,
    }
    authorize_url = f"{meta['authorization_endpoint']}?{urllib.parse.urlencode(params)}"
    resp = RedirectResponse(authorize_url, status_code=302)
    resp.set_cookie(STATE_COOKIE, f"{state}|{nonce}", httponly=True, secure=True,
                    samesite="lax", max_age=600, path="/auth")
    return resp


@router.get("/auth/callback")
async def callback(request: Request, code: str | None = None, state: str | None = None,
                   error: str | None = None, error_description: str | None = None,
                   bookflow_oidc_state: str | None = Cookie(default=None)):
    if error:
        raise HTTPException(status_code=400, detail=f"Entra error: {error} · {error_description}")
    if not code or not state:
        raise HTTPException(status_code=400, detail="missing code or state")
    if not bookflow_oidc_state or "|" not in bookflow_oidc_state:
        raise HTTPException(status_code=400, detail="missing or malformed state cookie")
    expected_state, expected_nonce = bookflow_oidc_state.split("|", 1)
    if state != expected_state:
        raise HTTPException(status_code=400, detail="state mismatch · CSRF guard")

    meta = await _get_oidc_meta()
    redirect_uri = f"{settings.public_base_url}{settings.redirect_path}"
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.post(meta["token_endpoint"], data={
            "grant_type": "authorization_code",
            "client_id": settings.entra_client_id,
            "client_secret": settings.entra_client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
        }, headers={"Accept": "application/json"})
        if r.status_code != 200:
            log.error("token endpoint %s · %s", r.status_code, r.text[:200])
            raise HTTPException(status_code=502, detail="token exchange failed")
        tok = r.json()
    id_token = tok.get("id_token")
    if not id_token:
        raise HTTPException(status_code=502, detail="no id_token in response")

    jwks = await _get_jwks()
    claims = authlib_jwt.decode(id_token, jwks)
    claims.validate()
    if claims.get("aud") != settings.entra_client_id:
        raise HTTPException(status_code=401, detail="aud mismatch")
    if claims.get("nonce") != expected_nonce:
        raise HTTPException(status_code=401, detail="nonce mismatch")

    oid = str(claims.get("oid") or claims.get("sub"))
    email = str(claims.get("email") or claims.get("preferred_username") or "")
    display_name = str(claims.get("name") or email)
    groups = [str(g) for g in (claims.get("groups") or [])]

    user = db.upsert_user(oid=oid, email=email, display_name=display_name, groups=groups)
    bookflow_jwt = jwt_issuer.issue(
        user_id=user["user_id"], email=user["email"],
        role=user["role"], scope_wh_id=user["scope_wh_id"], scope_store_id=user["scope_store_id"],
    )
    resp = RedirectResponse(settings.public_base_url, status_code=302)
    resp.set_cookie(COOKIE_NAME, bookflow_jwt, httponly=True, secure=True,
                    samesite="lax", max_age=settings.jwt_ttl_seconds, path="/")
    resp.delete_cookie(STATE_COOKIE, path="/auth")
    return resp


@router.get("/auth/whoami")
def whoami(bookflow_session: str | None = Cookie(default=None)):
    if not bookflow_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no session")
    try:
        claims = jwt_issuer.verify(bookflow_session)
    except pyjwt.PyJWTError as e:
        raise HTTPException(status_code=401, detail=f"invalid jwt: {e}")
    return JSONResponse({
        "user_id": claims["sub"],
        "email": claims["email"],
        "role": claims["role"],
        "scope_wh_id": claims.get("scope_wh_id"),
        "scope_store_id": claims.get("scope_store_id"),
        "exp": claims["exp"],
    })


@router.get("/auth/logout")
async def logout():
    meta = await _get_oidc_meta()
    end_session = meta.get("end_session_endpoint", settings.public_base_url)
    post_logout = urllib.parse.quote(settings.public_base_url, safe="")
    resp = RedirectResponse(f"{end_session}?post_logout_redirect_uri={post_logout}", status_code=302)
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp
