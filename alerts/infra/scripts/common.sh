#!/bin/bash
#
# Common Utilities Library
#
# Purpose:
#   Provides shared functions and utilities for all shell scripts in the project.
#   This includes logging functions, color definitions, requirement checks,
#   and helper functions for common operations.
#
# Usage:
#   # Source the file
#   source scripts/common.sh
#
# Functions Provided:
#   - info "message": Print green [INFO] message
#   - warn "message": Print yellow [WARN] message
#   - error "message": Print red [ERROR] message
#   - check_tools "tool1" "tool2": Check if required tools are installed
#   - get_script_dir: Get absolute path to script's directory
#   - get_project_root: Get absolute path to project root
#   - get_module_dir: Get absolute path to module directory (for module scripts)
#   - read_tfvars_value "var_name": Read value from terraform.tfvars
#   - read_tfvar "var_name" "vars_file": Read default from variables.tf (fails loudly if not found)
#   - read_tfvar_default_number "var_name" "fallback" "vars_file": Read numeric default
#   - read_tf_main_value "main_tf" "pattern" "fallback": Read value from main.tf
#   - check_terraform_root: Verify script is run from Terraform root directory
#   - start_spinner "message": Start a spinner with the given message
#   - cleanup_spinner: Stop spinner and restore cursor
#
# Color Variables:
#   - RED, GREEN, YELLOW, BLUE, CYAN, NC (No Color)
#
# Example:
#   source scripts/common.sh
#   check_tools "gcloud" "terraform"
#   info "Starting deployment..."
#   PROJECT_ROOT=$(get_project_root)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
export ORANGE=$'\033[38;5;208m' # Orange (256-color, using $'...' syntax for proper escaping)
export BLUE='\033[0;34m'
export CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Function to print colored output
info() {
	echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
	echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
	echo -e "${RED}[ERROR]${NC} $1"
}

# Check for required tools
# Usage: check_tools "tool1" "tool2" "tool3"
# Example: check_tools "gcloud" "jq" "terraform"
check_tools() {
	local missing_tools=()

	# Check each tool passed as argument
	for tool in "$@"; do
		if ! command -v "${tool}" &>/dev/null; then
			missing_tools+=("${tool}")
		fi
	done

	if [[ ${#missing_tools[@]} -gt 0 ]]; then
		error "Missing required tools: ${missing_tools[*]}"
		error "Please install the missing tools and try again"
		exit 1
	fi
}

# Get the directory where the script is located
# Usage: SCRIPT_DIR=$(get_script_dir)
# Returns: Absolute path to the script's directory
get_script_dir() {
	cd "$(dirname "${BASH_SOURCE[1]}")" && pwd
}

# Get the project root directory (assumes scripts are in scripts/ subdirectory)
# Usage: PROJECT_ROOT=$(get_project_root)
# Returns: Absolute path to the project root
get_project_root() {
	local script_dir
	script_dir=$(get_script_dir)
	cd "${script_dir}/.." && pwd
}

# Get the module directory (for scripts in module/scripts/ subdirectory)
# Usage: MODULE_DIR=$(get_module_dir)
# Returns: Absolute path to the module directory
get_module_dir() {
	local script_dir
	script_dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
	cd "${script_dir}/.." && pwd
}

# Read a value from terraform.tfvars file
# Usage: read_tfvars_value "variable_name" [default_value]
# Example: API_KEY=$(read_tfvars_value "quicknode_api_key")
read_tfvars_value() {
	local var_name="$1"
	local default_value="${2-}"
	local tfvars_file
	local project_root
	project_root=$(get_project_root)
	tfvars_file="${project_root}/terraform.tfvars"

	if [[ ! -f ${tfvars_file} ]]; then
		echo "${default_value}"
		return
	fi

	# Try double quotes first
	local value
	value=$(grep "^${var_name}" "${tfvars_file}" | head -1 | sed 's/.*= *"\(.*\)".*/\1/' || true)
	value=${value:-""}

	# If empty, try single quotes
	if [[ -z ${value} ]]; then
		value=$(grep "^${var_name}" "${tfvars_file}" | head -1 | sed "s/.*= *'\(.*\)'.*/\1/" || true)
		value=${value:-""}
	fi

	# If still empty, try without quotes (for numbers, booleans)
	if [[ -z ${value} ]]; then
		value=$(grep "^${var_name}" "${tfvars_file}" | head -1 | sed 's/.*= *\(.*\)/\1/' | tr -d '[:space:]' || true)
		value=${value:-""}
	fi

	if [[ -n ${value} ]]; then
		echo "${value}"
	else
		echo "${default_value}"
	fi
}

# Check if we're in a Terraform root directory (has main.tf)
# Usage: check_terraform_root [error_message]
check_terraform_root() {
	local error_msg="${1:-Error: main.tf not found. Please run this script from the terraform root directory.}"
	if [[ ! -f "main.tf" ]]; then
		error "${error_msg}"
		exit 1
	fi
}

# Read a default value from variables.tf file
# Usage: read_tfvar "variable_name" "vars_file_path"
# Example: region=$(read_tfvar "region" "${ROOT_DIR}/variables.tf")
# Fails loudly if the variable file doesn't exist or the value couldn't be read
read_tfvar() {
	local var_name="$1"
	local vars_file="$2"

	if [[ ! -f ${vars_file} ]]; then
		error "Variables file not found: ${vars_file}"
		exit 1
	fi

	# Extract default value using awk pattern matching
	local value
	local awk_output
	awk_output=$(awk "/variable \"${var_name}\"/{f=1} f==1&&/default/{print \$3; exit}" "${vars_file}" 2>/dev/null | tr -d '",' || true)
	value="${awk_output}"

	if [[ -z ${value} ]]; then
		error "Could not read default value for variable '${var_name}' from ${vars_file}"
		exit 1
	fi

	echo "${value}"
}

# Read a numeric default value from variables.tf file
# Usage: read_tfvar_default_number "variable_name" "fallback_value" "vars_file_path"
# Example: memory=$(read_tfvar_default_number "memory_mb" "256" "${MODULE_DIR}/variables.tf")
read_tfvar_default_number() {
	local var_name="$1"
	local fallback="$2"
	local vars_file="$3"

	local value
	value=$(read_tfvar "${var_name}" "${vars_file}")

	# Validate it's a number
	if [[ ${value} =~ ^[0-9]+$ ]]; then
		echo "${value}"
	else
		echo "${fallback}"
	fi
}

# Read a value from main.tf using an awk pattern
# Usage: read_tf_main_value "main_tf_path" "awk_pattern" "fallback"
# Example: runtime=$(read_tf_main_value "${main_tf}" '/build_config/{f=1} f==1&&/runtime.*=/{gsub(/[^"]*"|".*/, ""); print; exit}' "nodejs22")
read_tf_main_value() {
	local main_tf="$1"
	local pattern="$2"
	local fallback="$3"

	if [[ ! -f ${main_tf} ]]; then
		echo "${fallback}"
		return
	fi

	local value
	value=$(awk "${pattern}" "${main_tf}" 2>/dev/null || echo "")

	if [[ -n ${value} ]]; then
		echo "${value}"
	else
		echo "${fallback}"
	fi
}

# Validate that a value is a non-negative integer
# Usage: validate_non_negative_int "value" "default" "name"
# Example: memory=$(validate_non_negative_int "${memory_raw}" "256" "memory_mb")
validate_non_negative_int() {
	local value="$1"
	local default="$2"
	local name="$3"

	if [[ -z ${value} ]] || [[ ${value} == "null" ]] || [[ ! ${value} =~ ^[0-9]+$ ]]; then
		warn "Invalid ${name} value '${value}', using default: ${default}"
		echo "${default}"
	else
		echo "${value}"
	fi
}

# Spinner functions for loading indicators
# Source spinner.sh if it exists (relative to this script's location)
_common_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${_common_script_dir}/spinner.sh" ]]; then
	# shellcheck source=scripts/spinner.sh
	source "${_common_script_dir}/spinner.sh"
fi
unset _common_script_dir
