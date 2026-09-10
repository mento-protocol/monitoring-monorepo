package bridge_test

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"text/template"
)

func TestBridgeNotifications(t *testing.T) {
	var contract struct{ Title, Body string }
	data, err := os.ReadFile(os.Getenv("BRIDGE_TEMPLATE_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatal(err)
	}
	title := template.Must(template.New("title").Funcs(template.FuncMap{"toUpper": strings.ToUpper}).Parse(contract.Title))
	body := template.Must(template.New("body").Parse(contract.Body))
	alert := func(status, name string, route bool) map[string]any {
		labels := map[string]string{"alertname": name}
		if route {
			labels["source_chain"] = "137"
			labels["destination_chain"] = "143"
			labels["token"] = "USDm"
			labels["status"] = "SENT"
		}
		return map[string]any{"Status": status, "Labels": labels, "Annotations": map[string]string{"summary": "FIRING SUMMARY", "description": "FIRING DESCRIPTION", "dashboard_url": "https://monitoring.mento.org/bridge-flows"}}
	}
	for _, tc := range []struct {
		name, status                        string
		alerts                              []map[string]any
		wantFiring, wantResolved, wantRoute bool
	}{
		{"firing-transfer", "firing", []map[string]any{alert("firing", "Bridge SENT warning", true)}, true, false, false},
		{"firing-observation", "firing", []map[string]any{alert("firing", "Bridge unavailable", false)}, true, false, false},
		{"resolved-transfer", "resolved", []map[string]any{alert("resolved", "Bridge SENT warning", true)}, false, true, true},
		{"resolved-observation", "resolved", []map[string]any{alert("resolved", "Bridge unavailable", false)}, false, true, false},
		{"mixed-group", "firing", []map[string]any{alert("firing", "Bridge SENT warning", true), alert("resolved", "Bridge SENT page", true)}, true, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := map[string]any{"Status": tc.status, "Alerts": tc.alerts}
			var renderedTitle, renderedBody bytes.Buffer
			if err := title.Execute(&renderedTitle, input); err != nil {
				t.Fatal(err)
			}
			if err := body.Execute(&renderedBody, input); err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(renderedTitle.String(), strings.ToUpper(tc.status)+":") {
				t.Fatal(renderedTitle.String())
			}
			for phrase, want := range map[string]bool{"FIRING SUMMARY": tc.wantFiring, "FIRING DESCRIPTION": tc.wantFiring, "Bridge alert resolved:": tc.wantResolved, "Route: 137 → 143 / USDm / SENT": tc.wantRoute, "https://monitoring.mento.org/bridge-flows": true} {
				if strings.Contains(renderedBody.String(), phrase) != want {
					t.Fatalf("unexpected presence of %q in %q", phrase, renderedBody.String())
				}
			}
			if strings.Contains(renderedBody.String(), "<no value>") {
				t.Fatal(renderedBody.String())
			}
		})
	}
}
