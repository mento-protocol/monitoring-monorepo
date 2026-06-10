#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

# Deploys the Cloud Function using gcloud.
# Requires an environment arg (e.g., staging, production).
deploy_via_gcloud() {
	printf "\n"

	# Load the project variables
	script_dir=$(dirname "$0")
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
		--runtime nodejs20 \
		--service-account "${project_service_account}" \
		--source . \
		--trigger-http

	echo "✅ All Done!"
}

deploy_via_gcloud
