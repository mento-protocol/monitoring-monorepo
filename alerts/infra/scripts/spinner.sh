#!/bin/bash
#
# Spinner Utility for Loading Indicators
#
# Purpose:
#   Provides spinner functions for displaying loading indicators in terminal scripts.
#   Useful for long-running operations where you want visual feedback.
#
# Usage:
#   # Source the file
#   source scripts/spinner.sh
#
#   # Start spinner
#   start_spinner "Loading data..."
#
#   # Do work...
#   sleep 5
#
#   # Cleanup spinner (automatically called on EXIT, INT, TERM)
#   cleanup_spinner
#
# Functions:
#   - start_spinner "message": Starts a spinner with the given message
#   - cleanup_spinner: Stops spinner and restores cursor (called automatically on exit)
#
# Note:
#   Spinner automatically cleans up on script exit, interrupt, or termination.
#   Manual cleanup is only needed if you want to stop it before script ends.

# Cleanup function to ensure cursor is restored
cleanup_spinner() {
	# Kill spinner if running
	if [[ -n ${spinner_pid-} ]] && kill -0 "${spinner_pid}" 2>/dev/null; then
		kill "${spinner_pid}" 2>/dev/null || true
	fi
	# Clear spinner line and show cursor
	printf "\r\033[K"
	tput cnorm 2>/dev/null || true
}

# Spinner function to display while fetching logs
# Usage: start_spinner "Loading message..."
start_spinner() {
	local message="${1:-Loading...}"
	local delay=0.1

	# trunk-ignore(shellcheck/SC1003)
	local spin_string='|/-\'

	# Hide cursor
	tput civis 2>/dev/null || true

	(
		while true; do
			local temp=${spin_string#?}
			printf "\r\033[1;36m%c\033[0m %s" "${spin_string}" "${message}"
			spin_string=${temp}${spin_string%"${temp}"}
			sleep "${delay}"
		done
	) &

	spinner_pid=$!
	# Ensure cleanup happens on exit
	trap cleanup_spinner EXIT INT TERM
}
