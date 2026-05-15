"""Dual-mode auth: mock-token-{role} (dev) + BookFlow internal JWT HS256 (prod, issued by auth-pod).

env AUTH_MODE: 'mock' (default · accept mock-token-X) or 'jwt' (accept JWT only).
JWT mode reads:
  - Authorization: Bearer <token> header (Pod-to-Pod or curl), OR
  - bookflow_session cookie (browser SPA after Entra OIDC login).
"""
import os

import jwt as pyjwt
from fastapi import Cookie, Header, HTTPException, status

AUTH_MODE = os.environ.get("AUTH_MODE", "mock").lower()
JWT_SIGNING_KEY = os.environ.get("AUTH_JWT_SIGNING_KEY", "")
JWT_ISSUER = os.environ.get("AUTH_JWT_ISSUER", "bookflow-auth-pod")
JWT_AUDIENCE = os.environ.get("AUTH_JWT_AUDIENCE", "bookflow-services")

ROLE_USERS = {
    "hq-admin":     ("00000000-0000-0000-0000-000000000001", "hq-admin",     None, None),
    "wh-manager-1": ("00000000-0000-0000-0000-000000000002", "wh-manager",      1, None),
    "wh-manager-2": ("00000000-0000-0000-0000-000000000003", "wh-manager",      2, None),
    "branch-clerk": ("00000000-0000-0000-0000-000000000004", "branch-clerk", None,    1),
}


class AuthContext:
    __slots__ = ("user_id", "role", "scope_wh_id", "scope_store_id", "token")

    def __init__(self, user_id, role, scope_wh_id, scope_store_id, token=None):
        self.user_id = user_id
        self.role = role
        self.scope_wh_id = scope_wh_id
        self.scope_store_id = scope_store_id
        self.token = token


def _parse_mock(token: str, raw: str) -> AuthContext:
    role_key = token.removeprefix("mock-token-")
    user = ROLE_USERS.get(role_key)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"unknown role: {role_key}")
    return AuthContext(*user, token=raw)


def _parse_jwt(token: str, raw: str) -> AuthContext:
    if not JWT_SIGNING_KEY:
        raise HTTPException(status_code=503, detail="auth misconfigured: JWT key missing")
    try:
        claims = pyjwt.decode(
            token, JWT_SIGNING_KEY, algorithms=["HS256"],
            audience=JWT_AUDIENCE, issuer=JWT_ISSUER,
        )
    except pyjwt.PyJWTError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"invalid jwt: {e}")
    return AuthContext(
        user_id=claims["sub"],
        role=claims["role"],
        scope_wh_id=claims.get("scope_wh_id"),
        scope_store_id=claims.get("scope_store_id"),
        token=raw,
    )


def require_auth(
    authorization: str | None = Header(default=None),
    bookflow_session: str | None = Cookie(default=None),
) -> AuthContext:
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        if token.startswith("mock-token-"):
            return _parse_mock(token, authorization)
        return _parse_jwt(token, authorization)
    if bookflow_session:
        return _parse_jwt(bookflow_session, f"Bearer {bookflow_session}")
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token or session cookie")
