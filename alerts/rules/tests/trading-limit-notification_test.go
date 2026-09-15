package bridge_test

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"text/template"
)

// The three trading-limit rules carry a `pool_url` annotation that resolves the
// bytes32 limit id to the affected pool page (issue #2447). These tests pin
// three properties: the trading-limit templates render the link, they stay
// clean when the annotation is absent, and no other alert's template picks it
// up.

type limitAlert struct {
	Status       string
	Labels       map[string]string
	Annotations  map[string]string
	Values       map[string]any
	GeneratorURL string
}

type limitAlertGroups struct {
	Firing   []limitAlert
	Resolved []limitAlert
}

const poolURL = "https://monitoring.mento.org/limit/0xd580d237231109e6a96d67d855253150245af6ab7a62ae692295e92e51be073e"

func TestTradingLimitPoolLink(t *testing.T) {
	var contract struct {
		Slack          string `json:"trading_limits_slack"`
		Victorops      string `json:"trading_limits_victorops"`
		AegisSlack     string `json:"aegis_slack"`
		AegisVictorops string `json:"aegis_victorops"`
	}
	data, err := os.ReadFile(os.Getenv("BRIDGE_TEMPLATE_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	funcs := template.FuncMap{
		"title": func(value string) string {
			words := strings.Fields(value)
			for index, word := range words {
				words[index] = strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
			}
			return strings.Join(words, " ")
		},
		"reReplaceAll": func(pattern, replacement, value string) string {
			return regexp.MustCompile(pattern).ReplaceAllString(value, replacement)
		},
	}
	parse := func(body string) *template.Template {
		return template.Must(template.New("root").Funcs(funcs).Parse(body))
	}
	render := func(t *testing.T, parsed *template.Template, name string, input any) string {
		t.Helper()
		var output bytes.Buffer
		if err := parsed.ExecuteTemplate(&output, name, input); err != nil {
			t.Fatal(err)
		}
		return output.String()
	}

	alert := func(limitType string, annotations map[string]string) limitAlert {
		return limitAlert{
			Status: "firing",
			Labels: map[string]string{
				"alertname": limitType + " Trading Limit Alert [Celo]",
				"chain":     "celo",
				"limitId":   "CUSD_CAUD_POOL_CAUD_LIMIT",
				"limitType": limitType,
				"service":   "trading-limits",
			},
			Annotations:  annotations,
			Values:       map[string]any{"utilization": "99.9"},
			GeneratorURL: "https://mentolabs.grafana.net/alerting/grafana/abc/view",
		}
	}
	group := func(alerts ...limitAlert) map[string]any {
		return map[string]any{
			"Alerts":       limitAlertGroups{Firing: alerts},
			"CommonLabels": map[string]string{"alertname": "LG Trading Limit Alert [Celo]"},
		}
	}

	for _, destination := range []struct {
		name     string
		template string
		define   string
		wantLink string
	}{
		{"slack", contract.Slack, "slack.trading_limits_alert_message", "<" + poolURL + "|Open the pool page>"},
		{"victorops", contract.Victorops, "victorops.trading_limits_alert_message", "Pool page: " + poolURL},
	} {
		parsed := parse(destination.template)

		for _, limitType := range []string{"L0", "L1", "LG"} {
			t.Run(destination.name+"-"+limitType+"-renders-the-pool-link", func(t *testing.T) {
				output := render(t, parsed, destination.define, group(alert(limitType, map[string]string{"pool_url": poolURL})))
				if !strings.Contains(output, destination.wantLink) {
					t.Fatalf("missing %q in %q", destination.wantLink, output)
				}
				if strings.Contains(output, "<no value>") {
					t.Fatalf("unresolved template value in %q", output)
				}
			})
		}

		t.Run(destination.name+"-without-the-annotation-renders-no-link", func(t *testing.T) {
			output := render(t, parsed, destination.define, group(alert("LG", map[string]string{})))
			if strings.Contains(output, "monitoring.mento.org/limit/") {
				t.Fatalf("unexpected pool link in %q", output)
			}
			if strings.Contains(output, "<no value>") {
				t.Fatalf("unresolved template value in %q", output)
			}
			// The annotation guard must not leave a dangling bullet either.
			for _, line := range strings.Split(output, "\n") {
				if strings.TrimSpace(line) == "-" {
					t.Fatalf("empty bullet left by the guard in %q", output)
				}
			}
		})
	}

	// A pool_url on any other alert must stay invisible: the annotation is read
	// only by the trading-limit templates.
	for _, destination := range []struct {
		name     string
		template string
		define   string
	}{
		{"slack", contract.AegisSlack, "slack.aegis_service_alert_message"},
		{"victorops", contract.AegisVictorops, "victorops.aegis_service_alert_message"},
	} {
		t.Run(destination.name+"-other-alerts-ignore-the-annotation", func(t *testing.T) {
			other := limitAlert{
				Status: "firing",
				Labels: map[string]string{"alertname": "Aegis quota exhausted"},
				Annotations: map[string]string{
					"summary":  "Aegis quota exhausted.",
					"pool_url": poolURL,
				},
			}
			output := render(t, parse(destination.template), destination.define, map[string]any{
				"Alerts":       limitAlertGroups{Firing: []limitAlert{other}},
				"CommonLabels": map[string]string{"alertname": "Aegis quota exhausted"},
			})
			if !strings.Contains(output, "Aegis quota exhausted.") {
				t.Fatalf("missing summary in %q", output)
			}
			if strings.Contains(output, "monitoring.mento.org/limit/") {
				t.Fatalf("unexpected pool link in %q", output)
			}
		})
	}
}
