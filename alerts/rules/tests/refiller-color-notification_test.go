package bridge_test

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"text/template"
)

// The refiller early warning ("Low Refiller Balance [<chain>]") gets a
// yellow Slack side bar on `slack_alerts_oracles` and `slack_alerts_testnet`
// (protocol-contact-points.tf `color`, relayer-balance-locals.tf
// `oracle_relayer_slack_color`). Every other alert on those two contact
// points must keep Grafana's own default: `#D63232` firing, `#36a64f`
// resolved (grafana/alerting templates/default_template.go
// DefaultMessageColor, matching receivers/util.go
// ColorAlertFiring/ColorAlertResolved). This covers the refiller early
// warning, the refiller urgent level (urgency=urgent, stays red), a signer
// low-balance alert, and a page-severity oracle alert, each firing and
// resolved.
func TestRefillerSlackColor(t *testing.T) {
	var contract map[string]any
	data, err := os.ReadFile(os.Getenv("BRIDGE_TEMPLATE_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	body, ok := contract["oracle_relayer_color"].(string)
	if !ok {
		t.Fatal("fixture lacks oracle_relayer_color")
	}
	earlyWarning, ok := contract["oracle_relayer_color_early_warning_name"].(string)
	if !ok {
		t.Fatal("fixture lacks oracle_relayer_color_early_warning_name")
	}
	urgent, ok := contract["oracle_relayer_color_urgent_name"].(string)
	if !ok {
		t.Fatal("fixture lacks oracle_relayer_color_urgent_name")
	}
	tmpl := template.Must(template.New("color").Parse(body))
	render := func(t *testing.T, status, alertname, urgency string) string {
		t.Helper()
		commonLabels := map[string]string{"alertname": alertname}
		if urgency != "" {
			commonLabels["urgency"] = urgency
		}
		input := map[string]any{"Status": status, "CommonLabels": commonLabels}
		var output bytes.Buffer
		if err := tmpl.Execute(&output, input); err != nil {
			t.Fatal(err)
		}
		return output.String()
	}

	for _, tc := range []struct {
		name      string
		alertname string
		urgency   string
	}{
		{"refiller-early-warning", earlyWarning, ""},
		{"refiller-urgent", urgent, "urgent"},
		{"signer-low-balance", "Low CELO Balance [Celo]", ""},
		{"page-severity-oracle", "Oldest Report Expired [Celo]", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wantFiring := "#D63232"
			if tc.name == "refiller-early-warning" {
				wantFiring = "#ECB22E"
			}
			if got := render(t, "firing", tc.alertname, tc.urgency); got != wantFiring {
				t.Fatalf("firing color = %q, want %q", got, wantFiring)
			}
			if got := render(t, "resolved", tc.alertname, tc.urgency); got != "#36a64f" {
				t.Fatalf("resolved color = %q, want #36a64f", got)
			}
		})
	}
}
