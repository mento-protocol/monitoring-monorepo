#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
	echo "Usage: $0 <input-file> <output-file>" >&2
	exit 2
fi

input_file=$1
output_file=$2

sed -E \
	-e 's#(https://discord(app)?\.com/api(/v[0-9]+)?/webhooks/[0-9]+/)[^"[:space:]\\]+#\1[REDACTED]#g' \
	-e 's#https://[^"[:space:]\\]*(victorops|splunk)[^"[:space:]\\]*#[REDACTED]#g' \
	-e 's#(\\?"token\\?"[[:space:]]*:[[:space:]]*\\?")[^"\\]+#\1[REDACTED]#g' \
	-e 's#(security_token[[:space:]]*[:=][[:space:]]*)[A-Za-z0-9._-]+#\1[REDACTED]#g' \
	-e 's#("token"[[:space:]]*:[[:space:]]*")[^"]+#\1[REDACTED]#g' \
	-e 's#(token[[:space:]]*=[[:space:]]*")[^"]+#\1[REDACTED]#g' \
	-e 's#(Authorization[[:space:]]*=[[:space:]]*"?Bot )[A-Za-z0-9._-]+#\1[REDACTED]#g' \
	"$input_file" > "$output_file"
