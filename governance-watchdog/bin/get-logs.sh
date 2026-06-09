#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

# Fetches the latest logs for the Cloud Function and displays them in the terminal.
get_function_logs() {
	# Load the project variables
	script_dir=$(dirname "$0")
	source "${script_dir}/get-project-vars.sh"

	printf "\n"
	echo "Fetching logs for function ${function_name} in region ${region}..."
	printf "\n"

	# Fetch function logs
	function_logs=$(gcloud functions logs read "${function_name}" \
		--region "${region}" \
		--project "${project_id}" \
		--format json \
		--limit 50 \
		--sort-by TIME_UTC)

	# Fetch Cloud Run stdout logs (application logs)
	cloudrun_logs=$(gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=${function_name} AND logName=projects/${project_id}/logs/run.googleapis.com%2Fstdout" \
		--project "${project_id}" \
		--format json \
		--limit 50)

	# Fetch Cloud Run HTTP request logs
	request_logs=$(gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=${function_name} AND logName=projects/${project_id}/logs/run.googleapis.com%2Frequests" \
		--project "${project_id}" \
		--format json \
		--limit 50)

	# Format function logs
	echo "${function_logs}" | jq -r '.[] |
if .level == "E" then
  "\u001b[31m[\(.level)]\u001b[0m \u001b[33m\(.time_utc)\u001b[0m: \(.log)"
elif .log == null then
  # Skip logs with null content
  empty
elif .level == null or .level == "" then
  if (.log | test("Skipping unknown event|No handler registered|Duplicate event detected|DEDUP|Events processed")) then
    "[WARN] \u001b[33m\(.time_utc)\u001b[0m: \(.log)"
  else
    "[INFO] \u001b[33m\(.time_utc)\u001b[0m: \(.log)"
  end
else
  "[\(.level)] \u001b[33m\(.time_utc)\u001b[0m: \(.log)"
end'

	# Format Cloud Run stdout logs (application logs)
	echo "${cloudrun_logs}" | jq -r '.[] |
if (.textPayload | test("Skipping unknown event|No handler registered|Duplicate event detected|DEDUP|Events processed")) then
  "[WARN] \u001b[33m\(.timestamp as $ts | $ts | split("T")[0] + " " + ($ts | split("T")[1] | split(".")[0]))\u001b[0m: \(.textPayload | rtrimstr("\n"))"
else
  "[INFO] \u001b[33m\(.timestamp as $ts | $ts | split("T")[0] + " " + ($ts | split("T")[1] | split(".")[0]))\u001b[0m: \(.textPayload | rtrimstr("\n"))"
end'

	# Format Cloud Run HTTP request logs
	echo "${request_logs}" | jq -r '.[] |
"[POST] \u001b[33m\(.timestamp as $ts | $ts | split("T")[0] + " " + ($ts | split("T")[1] | split(".")[0]))\u001b[0m: \(.httpRequest.requestMethod)\(.httpRequest.status)\(.httpRequest.requestSize // 0 | tonumber | . / 1024 | round)B \(.httpRequest.latency // "0s" | rtrimstr("s") | tonumber * 1000 | round)ms \(.httpRequest.userAgent // "unknown")"'

	logs_url="https://console.cloud.google.com/run/detail/${region}/${function_name}/observability/logs?project=${project_id}"
	printf '\n\033[1m%s\033[0m\n' "${logs_url}"
}

get_function_logs "$@"
