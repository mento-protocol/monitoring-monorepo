#!/bin/bash

# Prepare agent.yaml with values from environment variables
set -euo pipefail

escape_sed_replacement() {
	printf '%s' "$1" | sed 's/[\\&|]/\\&/g'
}

endpoint=$(escape_sed_replacement "$GRAFANA_AGENT_ENDPOINT")
username=$(escape_sed_replacement "$GRAFANA_AGENT_USERNAME")
password=$(escape_sed_replacement "$GRAFANA_AGENT_PASSWORD")

sed "s|GRAFANA_AGENT_ENDPOINT|${endpoint}|g" agent.yaml.tmpl |
	sed "s|GRAFANA_AGENT_USERNAME|${username}|g" |
	sed "s|GRAFANA_AGENT_PASSWORD|${password}|g" >agent.yaml
