# Peg alerts carry a bounded decision package in annotations. Dedicated named
# templates keep peg-only fields out of the protocol-wide dispatchers. Template
# names are globally unique inside Grafana; contact points depend on these
# resources explicitly because their template calls are plain strings.

resource "grafana_message_template" "peg_slack_title" {
  name     = "Peg - Slack Title"
  template = <<-EOT
{{ define "peg.slack.title" -}}
{{ if (len .Alerts.Firing) }}{{ if eq .CommonLabels.severity "critical" }}🚨{{ else }}🟡{{ end }}{{ else }}✅{{ end }} {{ with .CommonLabels.alertname }}{{ . }}{{ else }}Peg monitoring{{ end }}
{{- end }}
EOT
}

resource "grafana_message_template" "peg_slack_message" {
  name     = "Peg - Slack Message"
  template = <<-EOT
{{ define "peg.slack.message" }}
{{ range .Alerts.Firing -}}
*FIRING: {{ with .Labels.alertname }}{{ . }}{{ else }}Peg monitoring{{ end }}* — `{{ with .Labels.asset }}{{ . }}{{ else }}unknown asset{{ end }}`{{ with .Labels.source }} / `{{ . }}`{{ end }}
{{ with .Annotations.summary }}{{ . }}{{ end }}
{{ with .Annotations.executable_price }}*Executable price:* {{ . }}{{ end }}
{{ with .Annotations.deviation_bps }}*Downside deviation:* {{ . }} bps{{ end }}
{{ with .Annotations.premium_bps }}*Premium:* {{ . }} bps{{ end }}
{{ with .Annotations.spread_bps }}*Spread:* {{ . }} bps{{ end }}
{{ with .Annotations.fill }}*Executable fill:* {{ . }}{{ end }}
{{ with .Annotations.listing_state }}*Listing state:* {{ . }}{{ end }}
{{ with .Annotations.listing_check_age }}*Listing checked:* {{ . }}{{ end }}
{{ with .Annotations.structural_saturation }}*Structural saturation:* {{ . }}{{ end }}
{{ with .Annotations.corroboration }}*Corroboration:* {{ . }}{{ end }}
*Policy:* `{{ with .Labels.policy_version }}{{ . }}{{ else }}unknown{{ end }}`
{{ with .Annotations.action }}*Action:* {{ . }}{{ end }}
*Started:* {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}
*Alert ID:* `{{ .Fingerprint }}`
{{ end -}}
{{ range .Alerts.Resolved -}}
*RESOLVED: {{ with .Labels.alertname }}{{ . }}{{ else }}Peg monitoring{{ end }}* — `{{ with .Labels.asset }}{{ . }}{{ else }}unknown asset{{ end }}`{{ with .Labels.source }} / `{{ . }}`{{ end }}
*Policy:* `{{ with .Labels.policy_version }}{{ . }}{{ else }}unknown{{ end }}`
*Resolved:* {{ .EndsAt.Format "Mon Jan 02 15:04 UTC" }}
*Alert ID:* `{{ .Fingerprint }}`
{{ end -}}
{{ if and (eq (len .Alerts.Firing) 0) (eq (len .Alerts.Resolved) 0) }}No peg alerts are present in this notification.{{ end }}
{{ end }}
EOT
}

resource "grafana_message_template" "peg_victorops_title" {
  name     = "Peg - VictorOps Title"
  template = <<-EOT
{{ define "peg.victorops.title" -}}
{{ if (len .Alerts.Firing) -}}
P1 {{ range $i, $alert := .Alerts.Firing }}{{ if $i }}, {{ end }}{{ with $alert.Labels.asset }}{{ . }}{{ else }}unknown asset{{ end }}: {{ with $alert.Labels.alertname }}{{ . }}{{ else }}peg page{{ end }}{{ end }}
{{- end }}
{{ if and (len .Alerts.Firing) (len .Alerts.Resolved) }} | {{ end -}}
{{ if (len .Alerts.Resolved) -}}
RESOLVED {{ range $i, $alert := .Alerts.Resolved }}{{ if $i }}, {{ end }}{{ with $alert.Labels.asset }}{{ . }}{{ else }}unknown asset{{ end }}: {{ with $alert.Labels.alertname }}{{ . }}{{ else }}peg page{{ end }}{{ end }}
{{- end }}
{{ if and (eq (len .Alerts.Firing) 0) (eq (len .Alerts.Resolved) 0) }}Peg status unknown{{ end }}
{{- end }}
EOT
}

resource "grafana_message_template" "peg_victorops_message" {
  name     = "Peg - VictorOps Message"
  template = <<-EOT
{{ define "peg.victorops.message" }}
{{ range .Alerts.Firing -}}
PROBLEM: {{ with .Annotations.summary }}{{ . }}{{ else }}A peg page is firing.{{ end }}
POLICY: {{ with .Labels.policy_version }}{{ . }}{{ else }}unknown{{ end }}{{ with .Labels.source }} SOURCE: {{ . }}{{ end }}
{{ with .Annotations.executable_price }}EXECUTABLE PRICE: {{ . }}{{ end }}
{{ with .Annotations.deviation_bps }}DOWNSIDE DEVIATION: {{ . }} bps{{ end }}
{{ with .Annotations.premium_bps }}PREMIUM: {{ . }} bps{{ end }}
{{ with .Annotations.spread_bps }}SPREAD: {{ . }} bps{{ end }}
{{ with .Annotations.fill }}EXECUTABLE FILL: {{ . }}{{ end }}
{{ with .Annotations.listing_state }}LISTING STATE: {{ . }}{{ end }}
{{ with .Annotations.listing_check_age }}LISTING CHECKED: {{ . }}{{ end }}
{{ with .Annotations.structural_saturation }}STRUCTURAL SATURATION: {{ . }}{{ end }}
{{ with .Annotations.corroboration }}CORROBORATION: {{ . }}{{ end }}
{{ with .Annotations.action }}ACTION: {{ . }}{{ end }}
Started: {{ .StartsAt.Format "Mon Jan 02 15:04 UTC" }}
Alert: {{ .GeneratorURL }}
{{ end -}}
{{ range .Alerts.Resolved -}}
RESOLVED: {{ with .Labels.alertname }}{{ . }}{{ else }}Peg page{{ end }} for {{ with .Labels.asset }}{{ . }}{{ else }}unknown asset{{ end }}.
Policy: {{ with .Labels.policy_version }}{{ . }}{{ else }}unknown{{ end }}
Resolved: {{ .EndsAt.Format "Mon Jan 02 15:04 UTC" }}
{{ end -}}
{{ if and (eq (len .Alerts.Firing) 0) (eq (len .Alerts.Resolved) 0) }}Peg status unknown.{{ end }}
{{ end }}
EOT
}

locals {
  peg_slack_title       = "{{ template \"peg.slack.title\" . }}"
  peg_slack_message     = "{{ template \"peg.slack.message\" . }}"
  peg_victorops_title   = "{{ template \"peg.victorops.title\" . }}"
  peg_victorops_message = "{{ template \"peg.victorops.message\" . }}"
}
