// 운영 엔지니어 전용 — Grafana 운영 대시보드를 iframe 으로 임베드.
// Grafana 는 auth.proxy + ingress forward-auth 로 자동 로그인되므로 별도 로그인 화면 없음.
// engineer 세션 쿠키(bookflow_session)가 /grafana 요청에 함께 실려 ingress auth_request 통과.

export default function OpsDashboard() {
  return (
    <div className="h-full flex flex-col">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-bf-text m-0">운영 대시보드</h2>
        <p className="text-[11px] text-bf-muted m-0 mt-0.5">
          멀티클라우드 인프라 관제 (Grafana · Prometheus / CloudWatch / Azure Monitor / GCP Monitoring)
        </p>
      </div>
      <iframe
        src="/grafana"
        title="BookFlow 운영 대시보드 (Grafana)"
        className="flex-1 w-full border border-bf-border rounded bg-white"
      />
    </div>
  );
}
