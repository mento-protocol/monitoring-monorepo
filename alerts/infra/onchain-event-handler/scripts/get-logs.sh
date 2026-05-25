#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

# Fetches the latest logs for the Cloud Function and displays them in the terminal.
get_function_logs() {
	# Load common utilities and project variables
	script_dir=$(dirname "$0")
	source "${script_dir}/../../scripts/common.sh"
	source "${script_dir}/get-project-vars.sh"

	# Start spinner while fetching logs
	start_spinner "Fetching logs for function ${function_name} in region ${region}..."
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

	# Stop spinner after fetching is complete
	cleanup_spinner

	# Merge and sort all logs chronologically
	{
		# Process function logs and normalize timestamp to ISO format
		echo "${function_logs}" | jq '.[] | 
select(.log != null) |
{
  timestamp_iso: (
    .time_utc |
    if test("^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}") then
      # Convert "YYYY-MM-DD HH:MM:SS" to ISO format "YYYY-MM-DDTHH:MM:SS.000Z"
      (split(" ") | .[0] + "T" + .[1] + ".000Z")
    elif test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T") then
      # Already in ISO format
      .
    else
      null
    end
  ),
  timestamp: .time_utc,
  type: "function",
  level: .level,
  log: .log
} | select(.timestamp_iso != null)'

		# Process Cloud Run stdout logs (structured JSON logs with severity)
		# Cloud Run logs can have either jsonPayload (structured) or textPayload (plain text)
		# jsonPayload structure: { logName, message: { message, ...metadata } } or { severity, message, ...metadata }
		# shellcheck disable=SC1078,SC1079,SC2026
		cloudrun_jq_script=$(
			cat <<'JQ_SCRIPT'
.[] |
{
  timestamp_iso: .timestamp,
  timestamp: (.timestamp | split("T")[0] + " " + (split("T")[1] | split(".")[0])),
  type: "stdout",
  textPayload: .textPayload,
  jsonPayload: (
    if .jsonPayload != null then
      .jsonPayload
    elif .textPayload != null then
      (.textPayload | try fromjson catch null)
    else
      null
    end
  )
} | if .jsonPayload != null then
  # Handle structured JSON payload
  # Cloud Run wraps logs in { logName, message: {...} } structure
  # Our logger creates { severity, message, ...metadata } structure
  # Extract the actual log data, handling both structures
  (
    if .jsonPayload.severity != null then
      # Direct severity field (from our logger)
      {
        severity: .jsonPayload.severity,
        logData: (.jsonPayload | del(.severity, .logName))
      }
    elif .jsonPayload.message != null then
      # Nested message structure (Cloud Run wrapper)
      if (.jsonPayload.message | type) == "object" then
        # message is an object with fields like { message, processed, total, ... }
        {
          severity: .jsonPayload.message.severity,
          logData: .jsonPayload.message
        }
      else
        # message is a string
        {
          severity: null,
          logData: { message: .jsonPayload.message }
        }
      end
    else
      # No message field, use entire payload (excluding logName)
      {
        severity: null,
        logData: (.jsonPayload | del(.logName))
      }
    end
  ) as $parsed |
  # Extract message and metadata from logData
  # logData structure: { message: "text", field1: value1, field2: value2, ... }
  (
    if $parsed.logData.message != null then
      if ($parsed.logData.message | type) == "string" then
        $parsed.logData.message
      else
        # message is an object, try to extract a message field or convert to string
        $parsed.logData.message.message // ($parsed.logData.message | tostring)
      end
    else
      # No message field, convert entire logData to string
      ($parsed.logData | tostring)
    end
  ) as $message |
  (
    # Extract all fields except "message" as metadata
    ($parsed.logData | del(.message) | to_entries | map("\(.key)=\(.value | tostring)") | join(", "))
  ) as $metadata |
  . + {
    severity: $parsed.severity,
    message: $message,
    metadata: $metadata,
    fullJson: null
  }
elif .textPayload != null then
  # Plain text payload
  . + { severity: null, message: .textPayload, metadata: "", fullJson: null }
else
  # Fallback for empty logs
  . + { severity: null, message: "(empty log entry)", metadata: "", fullJson: null }
end
JQ_SCRIPT
		)
		echo "${cloudrun_logs}" | jq -r "${cloudrun_jq_script}"

		# Process Cloud Run HTTP request logs
		echo "${request_logs}" | jq '.[] |
{
  timestamp_iso: .timestamp,
  timestamp: (.timestamp | split("T")[0] + " " + (split("T")[1] | split(".")[0])),
  type: "request",
  httpRequest: .httpRequest
}'
	} | jq -s 'sort_by(.timestamp_iso) | .[]' | jq -r '
if .type == "function" then
  if .level == "I" then
    "[INFO] __YELLOW__\(.timestamp)__NC__: \(.log)"
  elif .level == "WARNING" then
    "__ORANGE__[WARNING]__NC__ __YELLOW__\(.timestamp)__NC__: \(.log)"
  elif .level == "E" then
    "__RED__[ERROR]__NC__ __YELLOW__\(.timestamp)__NC__: \(.log)"
  elif .level == null or .level == "" then
    "[UNCLEAR] __YELLOW__\(.timestamp)__NC__: \(.log)"
  else
    "[\(.level)] __ORANGE__\(.timestamp)__NC__: \(.log)"
  end
elif .type == "stdout" then
  # Parse structured JSON logs with severity field
  if .severity != null then
    (if .metadata != "" then "\(.message) {\(.metadata)}" else .message end) as $log_line |
    if .severity == "ERROR" or .severity == "CRITICAL" then
      "__RED__[\(.severity)]__NC__ __YELLOW__\(.timestamp)__NC__: \($log_line)"
    elif .severity == "WARNING" then
      "__ORANGE__[WARNING]__NC__ __YELLOW__\(.timestamp)__NC__: \($log_line)"
    elif .severity == "INFO" then
      "[INFO] __YELLOW__\(.timestamp)__NC__: \($log_line)"
    elif .severity == "DEBUG" then
      "[DEBUG] __YELLOW__\(.timestamp)__NC__: \($log_line)"
    else
      "[\(.severity)] __YELLOW__\(.timestamp)__NC__: \($log_line)"
    end
  elif .message != null and .message != "" then
    # Display message content with metadata if available
    (if .metadata != null and .metadata != "" then "\(.message) {\(.metadata)}" else .message end) as $log_line |
    "[LOG] __YELLOW__\(.timestamp)__NC__: \($log_line)"
  else
    # Fallback for empty logs
    "[LOG] __YELLOW__\(.timestamp)__NC__: (empty log entry)"
  end
elif .type == "request" then
  "[\(.httpRequest.requestMethod)] __YELLOW__\(.timestamp)__NC__: \(.httpRequest.status) \(.httpRequest.responseSize // 0 | tonumber)B \(.httpRequest.latency // "0s" | rtrimstr("s") | tonumber * 1000 | round)ms \(.httpRequest.userAgent // "unknown")"
else
  empty
end' | {
		# Generate ANSI escape sequences using printf (works reliably in both bash and zsh)
		RED_ESC=$(printf '\033[0;31m')
		ORANGE_ESC=$(printf '\033[38;5;208m') # Orange (256-color mode) - falls back gracefully if not supported
		YELLOW_ESC=$(printf '\033[0;33m')
		NC_ESC=$(printf '\033[0m')

		# Replace placeholders with escape sequences
		while IFS= read -r line || [[ -n ${line} ]]; do
			line="${line//__RED__/${RED_ESC}}"
			line="${line//__ORANGE__/${ORANGE_ESC}}"
			line="${line//__YELLOW__/${YELLOW_ESC}}"
			line="${line//__NC__/${NC_ESC}}"
			# Output the line - escape sequences are actual bytes, terminal will interpret them
			printf '%s\n' "${line}"
		done
	}

	logs_url="https://console.cloud.google.com/run/detail/${region}/${function_name}/observability/logs?project=${project_id}"
	echo -e "\n${logs_url}"
}

get_function_logs "$@"
