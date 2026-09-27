package bridge_test

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"text/template"
	"time"
)

// ADR 0097: a resolved alert that carries a Grafana state reason must not
// claim recovery. Each case renders one firing alert, one ordinary recovery,
// and one state-reason stop per reason through the production template.
type stateReasonAlert struct {
	Status       string
	Labels       map[string]string
	Annotations  map[string]string
	Values       map[string]any
	GeneratorURL string
	Fingerprint  string
	StartsAt     time.Time
	EndsAt       time.Time
}

func TestStateReasonResolutionNotifications(t *testing.T) {
	var contract map[string]any
	data, err := os.ReadFile(os.Getenv("BRIDGE_TEMPLATE_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	funcs := template.FuncMap{
		"title": strings.ToUpper,
		"reReplaceAll": func(pattern, replacement, value string) string {
			return regexp.MustCompile(pattern).ReplaceAllString(value, replacement)
		},
	}
	render := func(t *testing.T, key, name string, input any) string {
		t.Helper()
		body, ok := contract[key].(string)
		if !ok {
			t.Fatalf("fixture lacks %s", key)
		}
		var output bytes.Buffer
		parsed := template.Must(template.New(key).Funcs(funcs).Parse(body))
		if err := parsed.ExecuteTemplate(&output, name, input); err != nil {
			t.Fatal(err)
		}
		return output.String()
	}
	alert := func(status, alertname, reason string) stateReasonAlert {
		return stateReasonAlert{
			Status: status,
			Labels: map[string]string{
				"alertname": alertname, "chain": "celo", "rateFeed": "CELOUSD", "explorer": "celoscan.io",
				"owner": "RelayerSignerCELOUSD", "ownerValue": "0xabc", "token": "CELO", "urgency": "urgent",
				"limitId": "0xlimit", "limitType": "L0", "severity": "critical",
			},
			Annotations: map[string]string{
				"currentBalance": "12,345.67", "runwayDays": "2", "threshold": "10", "topUpAmount": "50",
				"summary": "USDm peg deviates", "resolved_summary": "USDm peg recovered", "grafana_state_reason": reason,
			},
			Values:       map[string]any{"utilization": 91},
			GeneratorURL: "https://grafana.example/alert",
			Fingerprint:  "abc123",
		}
	}
	input := func(alertname string, firing, resolved []stateReasonAlert) map[string]any {
		return map[string]any{
			"Alerts":       map[string][]stateReasonAlert{"Firing": firing, "Resolved": resolved},
			"CommonLabels": map[string]string{"alertname": alertname, "urgency": "urgent", "chain": "celo", "severity": "critical"},
		}
	}
	claims := []string{"✅", "restored", "fresh again", "report fresh", "recovered", "resumed", "funded again", "cover refills again", "12,345.67"}
	stopped := "does not confirm recovery"

	for _, c := range []struct {
		key, prefix, alertname string
		slackIcon              bool   // the title is a status icon or starts with one
		titleClaim, bodyClaim  string // text an ordinary recovery renders; "" skips the check
	}{
		{"stale_price_slack", "slack.oracle_stale_price", "Oracle stale", true, "✅", "fresh again"},
		{"stale_price_victorops", "victorops.oracle_stale_price", "Oracle stale", false, "report fresh", "fresh again"},
		{"relayer_slack", "slack.oracle_relayer_low_balance", "Low relayer", true, "✅", "restored"},
		{"relayer_victorops", "victorops.oracle_relayer_low_balance", "Low relayer", false, "", "restored"},
		{"refiller_slack", "slack.relayer_refiller_low_balance", "Refiller", true, "✅", "cover refills again"},
		{"relayer_victorops", "victorops.relayer_refiller_low_balance", "Refiller", false, "", "cover refills again"},
		{"trading_mode_slack", "slack.trading_mode", "Trading mode", true, "Trading resumed", ""},
		{"trading_mode_victorops", "victorops.trading_mode", "Trading mode", false, "", "Trading resumed"},
		{"trading_limits_slack", "slack.trading_limits", "L0 limit", false, "", "✅ Trading Limit L0 resolved"},
		{"trading_limits_victorops", "victorops.trading_limits", "L0 limit", false, "", "Trading Limit L0 resolved"},
		{"aegis_slack", "slack.aegis_service", "Aegis does not report new data", true, "✅ Aegis data reporting recovered", "recovered"},
		{"aegis_victorops", "victorops.aegis_service", "Aegis does not report new data", false, "Aegis data reporting recovered", "recovered"},
		{"peg_slack", "peg.slack", "Peg", true, "✅", "USDm peg recovered"},
		{"peg_victorops", "peg.victorops", "Peg", false, "USDm peg recovered", "USDm peg recovered"},
	} {
		t.Run(c.prefix, func(t *testing.T) {
			title, message := c.prefix+"_alert_title", c.prefix+"_alert_message"
			if strings.HasPrefix(c.prefix, "peg.") {
				title, message = c.prefix+".title", c.prefix+".message"
			}
			firing := input(c.alertname, []stateReasonAlert{alert("firing", c.alertname, "")}, nil)
			for _, output := range []string{render(t, c.key, title, firing), render(t, c.key, message, firing)} {
				if strings.Contains(output, stopped) || strings.Contains(output, "⚪") {
					t.Fatalf("firing output = %q", output)
				}
			}

			recovered := input(c.alertname, nil, []stateReasonAlert{alert("resolved", c.alertname, "")})
			if got := render(t, c.key, title, recovered); c.titleClaim != "" && !strings.Contains(got, c.titleClaim) {
				t.Fatalf("recovery title = %q, want %q", got, c.titleClaim)
			}
			if got := render(t, c.key, message, recovered); strings.Contains(got, stopped) || c.bodyClaim != "" && !strings.Contains(got, c.bodyClaim) {
				t.Fatalf("recovery message = %q, want %q", got, c.bodyClaim)
			}

			for _, reason := range []string{"MissingSeries", "NoData", "Error", "Updated", "Paused", "RuleDeleted"} {
				stop := input(c.alertname, nil, []stateReasonAlert{alert("resolved", c.alertname, reason)})
				titleOutput := render(t, c.key, title, stop)
				if c.slackIcon && !strings.Contains(titleOutput, "⚪") {
					t.Fatalf("%s title = %q, want ⚪", reason, titleOutput)
				}
				messageOutput := render(t, c.key, message, stop)
				if !strings.Contains(messageOutput, stopped) {
					t.Fatalf("%s message lacks %q: %q", reason, stopped, messageOutput)
				}
				for _, output := range []string{titleOutput, messageOutput} {
					for _, claim := range claims {
						if strings.Contains(output, claim) {
							t.Fatalf("%s output claims recovery %q: %q", reason, claim, output)
						}
					}
				}
			}
		})
	}
}
