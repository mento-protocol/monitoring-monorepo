#!/bin/sh
# Keep a zero-allocation manual-scaling version healthy without starting Alloy.
# App Engine infrastructure probes remain successful; collector health stays
# unavailable until the supervisor explicitly activates Alloy.

set -eu

IFS=' ' read -r _method path _protocol || exit 0

case "${path}" in
  /_ah/health | /_ah/warmup)
    status="200 OK"
    body="passive"
    ;;
  /-/healthy)
    status="200 OK"
    body="collector-passive"
    ;;
  *)
    status="503 Service Unavailable"
    body="collector inactive"
    ;;
esac

printf 'HTTP/1.1 %s\r\nContent-Type: text/plain\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
  "${status}" "${#body}" "${body}"
