#!/bin/bash
set -e          # Fail on any error
set -o pipefail # Ensure piped commands propagate exit codes properly
set -u          # Treat unset variables as an error when substituting

# Check if an argument was provided
if [[ $# -eq 0 ]]; then
	echo "Error: Please provide a test type (ProposalCreated, ProposalQueued, ProposalExecuted, ProposalCanceled, or healthcheck)"
	exit 1
fi

# Ensure we're in the correct project before running gcloud commands
echo "🔍 Validating Google Cloud project configuration..."

# Source the project variables to get the correct project information
# This script will ensure we're in the right project and cache the values
source "$(dirname "$0")/get-project-vars.sh"

# Validate that we have a project_id from the sourced script
if [[ -z ${project_id-} ]]; then
	echo "⚠️  No project ID found. Clearing cache and re-initializing project configuration..."
	"$(dirname "$0")/get-project-vars.sh" --invalidate-cache
	# Re-source to get the updated project_id
	source "$(dirname "$0")/get-project-vars.sh"

	# Check again after cache invalidation
	if [[ -z ${project_id-} ]]; then
		echo "❌ Error: Still could not determine project ID after cache invalidation."
		exit 1
	fi
fi

# Double-check that gcloud is configured for the correct project
current_gcloud_project=$(gcloud config get project 2>/dev/null || echo "")
if [[ ${current_gcloud_project} != "${project_id}" ]]; then
	echo "⚠️  gcloud is configured for project '${current_gcloud_project}' but should be '${project_id}'"
	echo "   Automatically fixing project configuration..."
	"$(dirname "$0")/get-project-vars.sh" --invalidate-cache

	# Re-source to get the updated configuration
	source "$(dirname "$0")/get-project-vars.sh"

	# Verify the fix worked
	current_gcloud_project=$(gcloud config get project 2>/dev/null || echo "")
	if [[ ${current_gcloud_project} != "${project_id}" ]]; then
		echo "❌ Error: Failed to set correct project. Current: '${current_gcloud_project}', Expected: '${project_id}'"
		exit 1
	fi
	echo "✅ Successfully set gcloud project to '${project_id}'"
fi

echo "✅ Validated: Using Google Cloud project '${project_id}'"

TEST_TYPE=$1

# Map the test type to the corresponding fixture file
case ${TEST_TYPE} in
"ProposalCreated")
	FIXTURE_FILE="src/events/fixtures/proposal-created.fixture.json"
	;;
"ProposalQueued")
	FIXTURE_FILE="src/events/fixtures/proposal-queued.fixture.json"
	;;
"ProposalExecuted")
	FIXTURE_FILE="src/events/fixtures/proposal-executed.fixture.json"
	;;
"ProposalCanceled")
	FIXTURE_FILE="src/events/fixtures/proposal-canceled.fixture.json"
	;;
"healthcheck")
	FIXTURE_FILE="src/events/fixtures/health-check.fixture.json"
	;;
*)
	echo "Error: Invalid test type. Must be one of: ProposalCreated, ProposalQueued, ProposalExecuted, ProposalCanceled, healthcheck"
	exit 1
	;;
esac

# This only works if the function has been deployed and your `terraform` can access the state backend
raw_function_url=$(terraform -chdir=infra output -json function_uri)
function_url=$(echo "${raw_function_url}" | jq -r)
auth_token=$(gcloud secrets versions access latest --secret x-auth-token)

curl "${function_url}" \
	-H "Content-Type: application/json" \
	-H "X-AUTH-TOKEN: ${auth_token}" \
	-d @"${FIXTURE_FILE}"
