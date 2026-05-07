{{/*
Image reference for a mock entry.
*/}}
{{- define "csp-mocks.image" -}}
{{- if not .root.Values.ecrRegistry -}}
{{- fail "ecrRegistry is required (--set ecrRegistry=ACCOUNT.dkr.ecr.REGION.amazonaws.com)" -}}
{{- end -}}
{{ .root.Values.ecrRegistry }}/{{ .root.Values.repoPrefix }}/{{ .mock.name }}:{{ .root.Values.imageTag }}
{{- end -}}

{{- define "csp-mocks.commonLabels" -}}
app.kubernetes.io/name: {{ .mock.name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
csp: {{ .mock.csp }}
purpose: csp-mock
{{- end -}}
