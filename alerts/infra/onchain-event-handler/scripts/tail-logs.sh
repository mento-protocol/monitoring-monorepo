#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

# Tails the logs for the Cloud Run service in real-time.
# Usage: tail-logs.sh [filter]
# Example: tail-logs.sh "severity>=ERROR"
# Example: tail-logs.sh "jsonPayload.multisigKey=mento"
tail_function_logs() {
	# Load common utilities and project variables
	script_dir=$(dirname "$0")
	source "${script_dir}/../../scripts/common.sh"
	source "${script_dir}/get-project-vars.sh"

	# Optional filter (first argument)
	local filter="${1-}"

	# Base log query - use parentheses like the working script
	query="(resource.labels.service_name=\"${function_name}\")"

	# Add filter if provided
	if [[ -n ${filter} ]]; then
		query="${query} AND ${filter}"
		printf "\nTailing logs with filter: \033[1m%s\033[0m\n\n" "${filter}"
	else
		printf "\nTailing all logs for \033[1m%s\033[0m\n\n" "${function_name}"
	fi

	# Tail logs in real-time with formatted output
	# Use --format "default" (YAML) instead of JSON - this is what works!
	# Parse YAML with awk like the working script
	printf "Query: %s\n" "${query}" >&2
	printf "Project: %s\n" "${project_id}" >&2
	printf "Function: %s\n\n" "${function_name}" >&2

	# Check if DEBUG mode - if so, print raw output
	if [[ ${DEBUG:-0} == "1" ]]; then
		printf "DEBUG MODE: Printing raw output\n" >&2
		gcloud beta logging tail "${query}" \
			--project "${project_id}" \
			--format "default" 2>&1 |
			grep --line-buffered -v -E "(UserWarning|pkg_resources|Initializing tail session|SyntaxWarning|invalid escape sequence|\.py:)" |
			cat
		return 0
	fi

	gcloud beta logging tail "${query}" \
		--project "${project_id}" \
		--format "default" 2>&1 |
		grep --line-buffered -v -E "(UserWarning|pkg_resources|Initializing tail session|SyntaxWarning|invalid escape sequence|\.py:)" |
		awk -v y="\033[33m" -v r="\033[31m" -v o="\033[38;5;208m" -v x="\033[0m" '
BEGIN {
	prev_t = ""
	prev_req_method = ""
	prev_req_status = ""
	prev_req_size = ""
	prev_req_latency_ms = 0
	prev_req_ua = ""
	prev_msg = ""
	prev_has_request = 0
	prev_status_color = x
	prev_sev_color = x
	prev_sev_tag = "[INFO]"
}
/^timestamp:/ {
	t = $2
	gsub(/['\''T]/, " ", t)
	gsub(/\.[0-9]+Z/, "", t)
	# If we already have HTTP request data, output it now
	if (has_request && req_method && req_status) {
		printf "%s[%s]%s %s%s%s: %s%s%s %sB %dms %s\n",
			status_color, req_method, x,
			y, t, x,
			status_color, req_status, x,
			req_size ? req_size : "0", req_latency_ms, req_ua ? req_ua : "unknown"
		fflush()
	}
}
/^severity:/ {
	s = $2
	gsub(/'\''/, "", s)
	# Severity is a number (200, 400, 500, etc.) for HTTP requests
	if (s >= 500) {
		sev_color = r
		sev_tag = "[ERROR]"
	} else if (s >= 400) {
		sev_color = o
		sev_tag = "[WARNING]"
	} else {
		sev_color = x
		sev_tag = "[INFO]"
	}
}
/^http_request:/ {
	in_http = 1
	has_request = 1
}
/^  request_method:/ {
	if (in_http) {
		req_method = $2
		gsub(/'\''/, "", req_method)
	}
}
/^  status:/ {
	if (in_http) {
		req_status = $2
		gsub(/'\''/, "", req_status)
		if (req_status >= 500) {
			status_color = r
		} else if (req_status >= 400) {
			status_color = o
		} else {
			status_color = x
		}
	}
}
/^  response_size:/ {
	if (in_http) {
		req_size = $2
		gsub(/'\''/, "", req_size)
	}
}
/^  latency:/ {
	if (in_http) {
		req_latency = $2
		gsub(/'\''/, "", req_latency)
		gsub(/s$/, "", req_latency)
		req_latency_ms = int(req_latency * 1000)
	}
}
/^  user_agent:/ {
	if (in_http) {
		req_ua = $2
		gsub(/'\''/, "", req_ua)
		# If we already have timestamp, output now (timestamp comes after user_agent in YAML)
		if (t && req_method && req_status) {
			printf "%s[%s]%s %s%s%s: %s%s%s %sB %dms %s\n",
				status_color, req_method, x,
				y, t, x,
				status_color, req_status, x,
				req_size ? req_size : "0", req_latency_ms, req_ua ? req_ua : "unknown"
			fflush()
		}
	}
}
/jsonPayload:/ {
	in_json = 1
}
/^    message:/ {
	if (in_json) {
		sub(/^    message: /, "")
		gsub(/^'\''|'\''$/, "")
		msg = $0
		if (t) {
			printf "%s%s%s %s%s%s: %s\n",
				sev_color, sev_tag, x,
				y, t, x,
				msg
			fflush()
		}
	}
}
/^  message:/ {
	if (!in_json) {
		sub(/^  message: /, "")
		gsub(/^'\''|'\''$/, "")
		msg = $0
		if (t) {
			printf "%s%s%s %s%s%s: %s\n",
				sev_color, sev_tag, x,
				y, t, x,
				msg
			fflush()
		}
	}
}
/^textPayload:/ {
	sub(/^textPayload: /, "")
	gsub(/^'\''|'\''$/, "")
	msg = $0
	if (t) {
		printf "%s%s%s %s%s%s: %s\n",
			sev_color, sev_tag, x,
			y, t, x,
			msg
		fflush()
	}
}
/^text_payload:/ {
	sub(/^text_payload: /, "")
	gsub(/^'\''|'\''$/, "")
	msg = $0
	if (t) {
		printf "%s%s%s %s%s%s: %s\n",
			sev_color, sev_tag, x,
			y, t, x,
			msg
		fflush()
	}
}
/^---$/ {
	# Reset for new entry
	t = ""
	s = ""
	sev_color = x
	sev_tag = "[INFO]"
	req_method = ""
	req_status = ""
	req_size = ""
	req_latency = ""
	req_latency_ms = 0
	req_ua = ""
	msg = ""
	has_request = 0
	status_color = x
	in_http = 0
	in_json = 0
}
'
}

tail_function_logs "$@"
