"""Dual-mode auth: mock (dev) + JWT (prod · BookFlow internal HS256 issued by auth-pod).

Mode selection via env AUTH_MODE: 'mock' (default) or 'jwt'.
JWT mode reads:
  - Authorization: Bearer <token> header, OR
  - bookflow_session cookie (set by auth-pod /auth/callback)
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

    def __init__(self, user_id, role, scope_wh_id, scope_store_id, token):
        self.user_id = user_id
        self.role = role
        self.scope_wh_id = scope_wh_id
        self.scope_store_id = scope_store_id
        self.token = token


def _parse_mock(token_value: str, raw: str) -> AuthContext:
    if not token_value.startswith("mock-token-"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="non-mock token")
    role_key = token_value.removeprefix("mock-token-")
    user = ROLE_USERS.get(role_key)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"unknown role: {role_key}")
    return AuthContext(*user, token=raw)


def _parse_jwt(token_value: str, raw: str) -> AuthContext:
    if not JWT_SIGNING_KEY:
        raise HTTPException(status_code=503, detail="auth misconfigured: JWT key missing")
    try:
        claims = pyjwt.decode(
            token_value, JWT_SIGNING_KEY, algorithms=["HS256"],
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


def parse_bearer(authorization: str | None, cookie_token: str | None = None) -> AuthContext:
    # 1) Authorization Bearer header (Pod-to-Pod · curl · SPA mock 버튼)
    #    mock-token-* 형식이면 항상 mock 처리 (개발 편의 · AUTH_MODE 무관 dual 지원)
    if authorization and authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
        if token.startswith("mock-token-"):
            return _parse_mock(token, authorization)
        return _parse_jwt(token, authorization)
    # 2) cookie (browser SPA after Entra OIDC login)
    if cookie_token:
        return _parse_jwt(cookie_token, f"Bearer {cookie_token}")
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing bearer token or session cookie")


def require_auth(
    authorization: str | None = Header(default=None),
    bookflow_session: str | None = Cookie(default=None),
) -> AuthContext:
    return parse_bearer(authorization, bookflow_session)


def _check_store_scope(ctx: AuthContext, store_id: int) -> None:
    """FR-A7.3 branch-clerk 매장 스코프 enforce."""
    if ctx.role == "branch-clerk":
        if ctx.scope_store_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="branch-clerk scope_store_id 부재 (인증 토큰 손상)",
            )
        if ctx.scope_store_id != store_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"자기 매장만 조회 가능 (scope_store_id={ctx.scope_store_id} · 요청 store_id={store_id})",
            )
