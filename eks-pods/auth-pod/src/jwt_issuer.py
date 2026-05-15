"""BookFlow internal JWT (HS256) · issued after successful Entra OIDC login.

다른 Pod (dashboard-svc, inventory-svc 등) 가 같은 jwt_signing_key 로 verify.
"""
import time
import jwt

from .settings import settings


def issue(user_id: str, email: str, role: str, scope_wh_id: int | None, scope_store_id: int | None) -> str:
    now = int(time.time())
    payload = {
        "iss": settings.jwt_issuer,
        "aud": settings.jwt_audience,
        "sub": user_id,           # Entra oid
        "email": email,
        "role": role,
        "scope_wh_id": scope_wh_id,
        "scope_store_id": scope_store_id,
        "iat": now,
        "exp": now + settings.jwt_ttl_seconds,
    }
    return jwt.encode(payload, settings.jwt_signing_key, algorithm="HS256")


def verify(token: str) -> dict:
    return jwt.decode(
        token,
        settings.jwt_signing_key,
        algorithms=["HS256"],
        audience=settings.jwt_audience,
        issuer=settings.jwt_issuer,
    )
