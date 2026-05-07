# EKS Pods (V6.2)

EKS · `ns: bookflow` · **7 Pod + 1 CronJob**

| Pod | 역할 |
|-----|------|
| `auth-pod` | 인증 게이트웨이 · Entra ID OIDC → JWT 발급/검증 |
| `dashboard-bff` | HUB · 프런트↔백엔드 단일 진입점 · 5 pod fan-in + WebSocket broker |
| `forecast-svc` | AI 수요예측 · BigQuery 조회 + Vertex AI 실시간 추론 |
| `decision-svc` | 3단계 의사결정 · 재분배 → 권역 이동 → EOQ 발주 계획 |
| `intervention-svc` | 승인 · 실행 단일 창구 · 발주 지시서/재분배 계획 최종 승인 |
| `inventory-svc` | 재고 단일 쓰기 + 실시간 push · POS 소비 (KEDA) · /adjust /reserve |
| `notification-svc` | 알림 채널 연결지점 |
| `publisher-watcher` | CronJob · 출판사 신간 신청 감지 (매 1분) |

## 빌드 → ECR

각 Pod 폴더에 `Dockerfile` + 앱 소스. CodePipeline 이 `main` 머지 감지 → CodeBuild → ECR push → EKS rolling update.
