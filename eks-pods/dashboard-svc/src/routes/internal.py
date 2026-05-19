"""Internal forward-auth route for the engineer operations dashboard (Grafana).

nginx ingress `auth-url` 가 Grafana ingress 요청마다 GET /internal/grafana-auth 를
호출한다. BookFlow 세션(bookflow_session 쿠키)을 검증해서:
  - role == 'engineer'  → 200 + 응답 헤더 X-WEBAUTH-USER (Grafana auth.proxy 자동 로그인)
  - 그 외 / 미인증      → 401 (nginx 가 그대로 클라이언트에 전달)

Grafana auth.proxy 는 신뢰된 X-WEBAUTH-USER 헤더만으로 자동 로그인하므로,
이 헤더는 BookFlow 인증을 통과한 engineer 요청에만 주입되어야 한다 (ingress 가
클라이언트의 위조 X-WEBAUTH-USER 를 제거 + auth-response-headers 로 이 헤더만 전달).
"""
from fastapi import APIRouter, Depends, Response, status

from ..auth import AuthContext, require_auth

router = APIRouter(prefix="/internal", tags=["internal"])


@router.get("/grafana-auth")
def grafana_auth(response: Response, ctx: AuthContext = Depends(require_auth)):
    """forward-auth 검증 엔드포인트 — engineer 만 통과시키고 X-WEBAUTH-USER 주입.

    require_auth 가 세션/토큰을 검증 (미인증이면 401 자동). 인증은 됐으나
    engineer 가 아니면 403 으로 Grafana 접근 차단.
    """
    if ctx.role != "engineer":
        response.status_code = status.HTTP_403_FORBIDDEN
        return {"detail": "engineer role 만 운영 대시보드 접근 가능"}
    response.headers["X-WEBAUTH-USER"] = ctx.email or ctx.user_id
    return {"status": "ok", "user": ctx.email or ctx.user_id}
