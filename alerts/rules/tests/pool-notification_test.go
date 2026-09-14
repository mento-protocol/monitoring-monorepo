package bridge_test

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"text/template"
	"time"
)

type poolAlert struct {
	Status      string
	Labels      map[string]string
	Annotations map[string]string
	StartsAt    time.Time
	EndsAt      time.Time
	Fingerprint string
}

func TestPoolResolutionNotifications(t *testing.T) {
	var contract struct {
		Slack      string `json:"pool_slack"`
		SlackTitle string `json:"pool_slack_title"`
		Victorops  string `json:"pool_victorops"`
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
		"toLower": strings.ToLower,
	}
	slack := template.Must(template.New("slack").Funcs(funcs).Parse(contract.Slack))
	slackTitle := template.Must(template.New("slack-title").Funcs(funcs).Parse(contract.SlackTitle))
	victorops := template.Must(template.New("victorops").Funcs(funcs).Parse(contract.Victorops))
	started := time.Date(2026, 9, 11, 23, 27, 0, 0, time.UTC)
	ended := started.Add(time.Minute)

	alert := func(status, reason string) poolAlert {
		return poolAlert{
			Status: status,
			Labels: map[string]string{
				"alertname":  "Pool Nearly One-Sided",
				"pool_id":    "42220-0x462fe04b4fd719cbd04c0310365d421d02aaa19e",
				"pair":       "USDC/USDm",
				"chain_name": "celo",
				"severity":   "page",
			},
			Annotations: map[string]string{
				"summary":                        "The USDm side has only 0.0% of pool value.",
				"resolved_title":                 "Pool Two-Sided Again",
				"resolved_summary":               "The thin side is back above the one-sided floor.",
				"non_threshold_resolved_title":   "Pool Alert Stopped Without Recovery Confirmation",
				"non_threshold_resolved_summary": "Grafana stopped the one-sided alert for a non-threshold state transition. This does not confirm that the pool recovered.",
				"current_reserves":                "USDm 60,950.30 / USDC 0.13",
				"value_composition":               "USDm 100.0% / USDC 0.0%",
				"grafana_state_reason":            reason,
			},
			StartsAt:    started,
			EndsAt:      ended,
			Fingerprint: "5163504623dfc161",
		}
	}

	render := func(t *testing.T, parsed *template.Template, input any) string {
		t.Helper()
		var output bytes.Buffer
		if err := parsed.Execute(&output, input); err != nil {
			t.Fatal(err)
		}
		return strings.ReplaceAll(output.String(), "*", "")
	}

	for _, destination := range []struct {
		name                string
		template            *template.Template
		showsResolvedTitle bool
	}{
		{"slack", slack, true},
		{"victorops", victorops, false},
	} {
		t.Run(destination.name+"-firing", func(t *testing.T) {
			input := map[string]any{"Status": "firing", "CommonAnnotations": map[string]string{}, "Alerts": []poolAlert{alert("firing", "")}}
			output := render(t, destination.template, input)
			for _, phrase := range []string{
				"The USDm side has only 0.0% of pool value.",
				"Reserves: USDm 60,950.30 / USDC 0.13",
				"Value Share: USDm 100.0% / USDC 0.0%",
			} {
				if !strings.Contains(strings.ToLower(output), strings.ToLower(phrase)) {
					t.Fatalf("missing %q in %q", phrase, output)
				}
			}
			for _, unexpected := range []string{"last alerting snapshot", "Pool Alert Stopped Without Recovery Confirmation"} {
				if strings.Contains(output, unexpected) {
					t.Fatalf("unexpected %q in firing message %q", unexpected, output)
				}
			}
			if destination.name == "slack" && render(t, slackTitle, input) != "🚨" {
				t.Fatalf("firing page must keep the pager icon")
			}
		})

		t.Run(destination.name+"-normal-recovery", func(t *testing.T) {
			input := map[string]any{"Status": "resolved", "CommonAnnotations": map[string]string{}, "Alerts": []poolAlert{alert("resolved", "")}}
			output := render(t, destination.template, input)
			if !strings.Contains(output, "The thin side is back above the one-sided floor.") {
				t.Fatalf("missing recovery summary in %q", output)
			}
			for _, omitted := range []string{"Reserves:", "Value Share:"} {
				if strings.Contains(strings.ToLower(output), strings.ToLower(omitted)) {
					t.Fatalf("resolved message must omit %q in %q", omitted, output)
				}
			}
			if destination.showsResolvedTitle && !strings.Contains(output, "Pool Two-Sided Again") {
				t.Fatalf("missing resolved title in %q", output)
			}
			if destination.name == "slack" && render(t, slackTitle, input) != "✅" {
				t.Fatalf("confirmed recovery must keep the resolved icon")
			}
		})

		for _, reason := range []string{"MissingSeries", "NoData", "No Data", "Error", "Updated", "Paused", "RuleDeleted"} {
			t.Run(destination.name+"-"+strings.ReplaceAll(reason, " ", "-"), func(t *testing.T) {
				input := map[string]any{"Status": "resolved", "CommonAnnotations": map[string]string{"grafana_state_reason": reason}, "Alerts": []poolAlert{alert("resolved", reason)}}
				output := render(t, destination.template, input)
				for _, phrase := range []string{
					"Pool Alert Stopped Without Recovery Confirmation",
					"This does not confirm that the pool recovered.",
				} {
					if !strings.Contains(strings.ToLower(output), strings.ToLower(phrase)) {
						t.Fatalf("missing %q for %s in %q", phrase, reason, output)
					}
				}
				for _, misleading := range []string{"Pool Two-Sided Again", "back above the one-sided floor"} {
					if strings.Contains(output, misleading) {
						t.Fatalf("unexpected recovery claim %q for %s in %q", misleading, reason, output)
					}
				}
				for _, omitted := range []string{"Reserves:", "Value Share:"} {
					if strings.Contains(strings.ToLower(output), strings.ToLower(omitted)) {
						t.Fatalf("%s resolution must omit %q in %q", reason, omitted, output)
					}
				}
				if destination.name == "slack" && render(t, slackTitle, input) != "⚪" {
					t.Fatalf("%s must render a neutral Slack icon", reason)
				}
			})
		}
	}
}
