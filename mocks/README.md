# BookFlow CSP Mocks

4 fake services that imitate real **cross-CSP** endpoints (Azure / GCP) so
pods can be developed/tested without those credentials. Wire format matches
the real APIs - swap the `*_BASE_URL` env in each pod and you are talking to
prod.

## Mocks

| Mock | Real target | Used by |
|---|---|---|
| `azure-entra-mock` | `login.microsoftonline.com` (OIDC) | auth-pod |
| `azure-logic-apps-mock` | `*.koreacentral.logic.azure.com` (12 webhooks) | notification-svc |
| `gcp-vertex-mock` | `*-aiplatform.googleapis.com` (predict) | forecast-svc |
| `gcp-bigquery-mock` | `bigquery.googleapis.com/bigquery/v2/.../queries` | forecast-svc |

The publisher new-book-request API is **not mocked** - it is a real BookFlow
component (EC2 ASG behind External ALB in Egress VPC, see V6.2 slide 28 +
`infra/aws/40-compute-runtime/publisher-asg.yaml`). publish-watcher CronJob
targets that ALB DNS via env `PUBLISHER_API_BASE_URL`.

## Endpoints

### azure-entra-mock
- `GET  /{tenant}/v2.0/.well-known/openid-configuration`
- `GET  /{tenant}/discovery/v2.0/keys`
- `GET  /{tenant}/oauth2/v2.0/authorize?...` -> 302 redirect with code
- `POST /{tenant}/oauth2/v2.0/token` (form-encoded) -> `{access_token, id_token, ...}`
- Signing key: dev RSA-2048 generated per pod start (kid stable per lifecycle).
- ID token claims align with RDS `users` seed (oid, email, role).

### azure-logic-apps-mock
- `POST /workflows/{workflow_id}/triggers/manual/paths/invoke?api-version=...&sig=...` -> 202
- `GET  /workflows/{workflow_id}/runs` -> last 100 invocations (debug)
- Workflow ids per the 12 events in V6.2 sheet 04 (OrderPending, ..., DeploymentRollback).

### gcp-vertex-mock
- `POST /v1/projects/{p}/locations/{r}/endpoints/{e}:predict`
- Returns deterministic predictions seeded by (isbn13, store_id) so
  unit tests get repeatable values.

### gcp-bigquery-mock
- `POST /bigquery/v2/projects/{p}/queries`
- Detects `forecast_results` queries -> 30 deterministic rows (D+2~D+5).
- Other tables -> empty.

## DNS (in-cluster)

```
azure-entra-mock.stubs.svc.cluster.local
azure-logic-apps-mock.stubs.svc.cluster.local
gcp-vertex-mock.stubs.svc.cluster.local
gcp-bigquery-mock.stubs.svc.cluster.local
```

## Build & deploy

Two-step: image push, then helm install/upgrade. (Weekend workaround until
CodeStar is available - then a CI/CD pipeline does the push, helm step stays
the same.)

```bash
# build + push only (no deploy)
AWS_PROFILE=bookflow-admin AWS_REGION=ap-northeast-1 ./build-all.sh

# build + push + helm upgrade in one shot
AWS_PROFILE=bookflow-admin AWS_REGION=ap-northeast-1 ./build-all.sh --deploy

# or run helm directly (chart only)
helm upgrade --install csp-mocks ./charts/csp-mocks \
  --create-namespace \
  --set ecrRegistry=994878981869.dkr.ecr.ap-northeast-1.amazonaws.com \
  --set imageTag=latest
```

Verify:

```bash
kubectl get pods -n stubs
kubectl get svc  -n stubs
kubectl run -n stubs curlpod --rm -it --image=curlimages/curl -- \
  curl -sf http://azure-entra-mock/health
```

## Helm chart structure

```
charts/csp-mocks/
  Chart.yaml
  values.yaml          # ecrRegistry, imageTag, mocks list (range)
  templates/
    namespace.yaml
    deployment.yaml    # range over .Values.mocks
    service.yaml       # range
    _helpers.tpl
```

Add or remove a mock by editing only `values.yaml`'s `mocks` list - templates
loop over it. New mock entry needs the matching directory `mocks/<name>/src/`
plus listing in `build-all.sh`.

## Switching pod target between mock and real

Each pod reads `*_BASE_URL` from a ConfigMap. Default points at the mock
service DNS. To talk to real prod, override the ConfigMap (or env) with the
real base URL - **no code change**.
