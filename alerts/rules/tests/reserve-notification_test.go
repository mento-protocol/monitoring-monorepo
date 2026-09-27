package bridge_test

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"text/template"
)

// ADR 0097: a resolved reserve alert with a Grafana state reason must not
// claim that the balance recovered.
func TestReserveResolutionNotifications(t *testing.T) {
	var contract struct {
		Slack     string `json:"reserve_slack"`
		Victorops string `json:"reserve_victorops"`
	}
	data, err := os.ReadFile(os.Getenv("BRIDGE_TEMPLATE_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	funcs := template.FuncMap{"title": strings.ToUpper}
	slack := template.Must(template.New("slack").Funcs(funcs).Parse(contract.Slack))
	victorops := template.Must(template.New("victorops").Funcs(funcs).Parse(contract.Victorops))
	render := func(t *testing.T, parsed *template.Template, name string, input any) string {
		t.Helper()
		var output bytes.Buffer
		if err := parsed.ExecuteTemplate(&output, name, input); err != nil {
			t.Fatal(err)
		}
		return output.String()
	}
	alert := func(status, band, severity, reason string) limitAlert {
		return limitAlert{
			Status:      status,
			Labels:      map[string]string{"token": "USDC", "owner": "Reserve", "ownerValue": "0xabc", "explorer": "polygonscan.com", "chain": "polygon", "severity": severity},
			Annotations: map[string]string{"band": band, "threshold": "60000", "currentBalance": "12,345.67", "grafana_state_reason": reason},
		}
	}
	input := func(firing, resolved []limitAlert) map[string]any {
		return map[string]any{"Alerts": limitAlertGroups{Firing: firing, Resolved: resolved}, "CommonLabels": map[string]string{"alertname": "Reserve"}}
	}
	recoveryClaims := []string{"restored", "left the", "above zero again"}
	stopped := "does not confirm recovery"

	firing := input([]limitAlert{alert("firing", "critical", "warning", "")}, nil)
	if got := render(t, slack, "slack.reserve_balance_alert_title", firing); got != "🔴" {
		t.Fatalf("firing title = %q", got)
	}
	for _, output := range []string{render(t, slack, "slack.reserve_balance_alert_message", firing), render(t, victorops, "victorops.reserve_balance_alert_message", firing)} {
		if !strings.Contains(output, "Critical USDC balance") && !strings.Contains(output, "FIRING: Low USDC balance") || strings.Contains(output, stopped) {
			t.Fatalf("firing message = %q", output)
		}
	}

	for _, recovery := range []struct{ band, severity, claim, icon string }{
		{"critical", "warning", "left the critical band", "🟡"},
		{"", "page", "above zero again", "🟡"},
		{"", "warning", "restored", "✅"},
	} {
		resolved := input(nil, []limitAlert{alert("resolved", recovery.band, recovery.severity, "")})
		if got := render(t, slack, "slack.reserve_balance_alert_title", resolved); got != recovery.icon {
			t.Fatalf("%s recovery title = %q", recovery.claim, got)
		}
		output := render(t, slack, "slack.reserve_balance_alert_message", resolved)
		if !strings.Contains(output, recovery.claim) || strings.Contains(output, stopped) {
			t.Fatalf("recovery message = %q", output)
		}
	}
	if output := render(t, victorops, "victorops.reserve_balance_alert_message", input(nil, []limitAlert{alert("resolved", "", "page", "")})); !strings.Contains(output, "above zero again") {
		t.Fatalf("victorops recovery message = %q", output)
	}

	for _, reason := range []string{"MissingSeries", "NoData", "No Data", "Error", "Updated", "Paused", "RuleDeleted"} {
		for _, shape := range [][2]string{{"critical", "warning"}, {"", "page"}, {"", "warning"}} {
			resolved := input(nil, []limitAlert{alert("resolved", shape[0], shape[1], reason)})
			if got := render(t, slack, "slack.reserve_balance_alert_title", resolved); got != "⚪" {
				t.Fatalf("%s title = %q", reason, got)
			}
			for _, output := range []string{render(t, slack, "slack.reserve_balance_alert_message", resolved), render(t, victorops, "victorops.reserve_balance_alert_message", resolved)} {
				if strings.Contains(output, "12,345.67") {
					t.Fatalf("%s message shows the carried-forward balance: %q", reason, output)
				}
				if !strings.Contains(output, stopped) {
					t.Fatalf("%s message lacks %q: %q", reason, stopped, output)
				}
				for _, claim := range recoveryClaims {
					if strings.Contains(output, claim) {
						t.Fatalf("%s message claims recovery %q: %q", reason, claim, output)
					}
				}
			}
		}
	}
}
