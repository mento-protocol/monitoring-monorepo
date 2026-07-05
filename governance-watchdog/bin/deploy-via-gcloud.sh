#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

# Deploys the Cloud Function using gcloud.
# Requires an environment arg (e.g., staging, production).
# function_name, function_entry_point, terraform_service_account,
# project_id, region, and project_service_account (referenced throughout
# below) are defined by get-project-vars.sh, sourced inside this function;
# `set -u` catches them at runtime if that ever changes. Disable scoped to
# this function (not file-wide) so an unrelated undefined-variable typo
# elsewhere still flags.
# shellcheck disable=SC2154 # covers: function_name, function_entry_point, terraform_service_account, project_id, region, project_service_account
deploy_via_gcloud() {
	printf "\n"

	# Load the project variables
	script_dir=$(dirname "$0")
	# shellcheck disable=SC1091 # runtime-resolved path; absent from Trunk's single-file sandbox copy
	source "${script_dir}/get-project-vars.sh"

	# Deploy the Google Cloud Function
	echo "Deploying to Google Cloud Functions..."
	gcloud functions deploy "${function_name}" \
		--allow-unauthenticated \
		--entry-point "${function_entry_point}" \
		--gen2 \
		--impersonate-service-account "${terraform_service_account}" \
		--project "${project_id}" \
		--region "${region}" \
		--runtime nodejs22 \
		--service-account "${project_service_account}" \
		--source . \
		--trigger-http

	echo "✅ All Done!"
}

deploy_via_gcloud
