#############################################
# QuickNode Webhook for Multisig Monitoring #
#############################################
# This module creates a QuickNode webhook that monitors Safe multisig events
# and sends them to the alert handler cloud function

# Delete old webhook before recreation (QuickNode doesn't support PUT updates)
# 
# IMPORTANT: Due to Terraform's execution model, the first apply may fail with 404.
# This happens because Terraform plans the update before the provisioner runs.
# 
# WORKAROUND: If you get a 404 error, run:
#   `terraform state rm 'module.onchain_event_listeners["celo"].restapi_object.multisig_webhook'`
#   `terraform apply`
#
# The provisioner will delete the old webhook and remove it from state,
# so the second apply will succeed by creating a new webhook instead of updating.
resource "null_resource" "pause_webhook_before_update" {
  # Include hash in a way that forces replacement
  # When hash changes, Terraform will replace this resource (destroy old, create new)
  triggers = {
    # Hash changes = resource replacement, not update
    webhook_data_hash = local.webhook_data_hash
    webhook_name      = var.webhook_name
    # Force replacement by including hash as a separate trigger
    replacement_trigger = local.webhook_data_hash
  }

  lifecycle {
    # Force replacement when triggers change (don't update in-place)
    create_before_destroy = false
  }

  # Run before Terraform tries to update the webhook
  # This deletes the old webhook and removes it from state, forcing recreation

  # Provisioner runs when resource is created/updated (when hash changes)
  provisioner "local-exec" {
    command = <<-EOT
      # Get webhook ID from Terraform state - find the exact resource path
      STATE_PATH=$(terraform state list | grep -E '\.multisig_webhook$' | grep -E 'onchain_event_listeners\[.*\]' | head -1)
      
      if [ -z "$STATE_PATH" ]; then
        echo "Webhook not found in state, skipping delete (first creation)"
        exit 0
      fi
      
      WEBHOOK_ID=$(terraform state show "$STATE_PATH" 2>/dev/null | grep -E '^\s+id\s+=' | awk '{print $3}' | tr -d '"' || echo "")
      
      if [ -n "$WEBHOOK_ID" ] && [ "$WEBHOOK_ID" != "" ]; then
        echo "Pausing and deleting old webhook $WEBHOOK_ID to force recreation..."
        
        # Use reusable script for webhook management
        SCRIPT_DIR="$$(cd "$$(dirname "$${BASH_SOURCE[0]}")/.." && pwd)"
        "$${SCRIPT_DIR}/scripts/manage-quicknode-webhook.sh" pause-and-delete "$WEBHOOK_ID" "${var.quicknode_api_key}"
        
        # Remove from Terraform state so Terraform will create instead of update
        echo "Removing webhook from Terraform state..."
        terraform state rm -lock=false "$STATE_PATH" 2>&1 | head -5
        echo "Webhook removed from state - Terraform will create a new one"
      else
        echo "Could not extract webhook ID from state, skipping delete"
      fi
    EOT
  }

}

# QuickNode webhook creation
# API Reference: https://www.quicknode.com/docs/webhooks/rest-api/webhooks/webhooks-rest-create-webhook
resource "restapi_object" "multisig_webhook" {
  provider = restapi.quicknode
  path     = "/webhooks/rest/v1/webhooks"

  # Configure paths for reading and deleting webhooks
  # Note: QuickNode doesn't support updates - we must recreate webhooks for any changes
  read_path    = "/webhooks/rest/v1/webhooks/{id}"
  destroy_path = "/webhooks/rest/v1/webhooks/{id}"

  # CRITICAL: Do NOT set update_path or update_method - this prevents update attempts entirely
  # Any configuration change will trigger replacement via replace_triggered_by lifecycle rule

  data = jsonencode({
    # Append hash to name to force replacement when config changes
    # This ensures Terraform sees it as a different resource requiring recreation
    name            = "${var.webhook_name}-${substr(local.webhook_data_hash, 0, 8)}"
    network         = var.quicknode_network_name
    filter_function = local.filter_function_base64
    destination_attributes = {
      url            = var.webhook_endpoint_url
      security_token = var.quicknode_signing_secret
      compression    = var.compression
    }
    status = "active"
  })

  id_attribute = "id"

  # Enable debug mode to see API responses
  debug = true

  lifecycle {
    # QuickNode doesn't support updates - force replacement for ANY change
    create_before_destroy = false # Delete old webhook before creating new one

    # Replace when configuration changes (via null_resource trigger)
    replace_triggered_by = [
      null_resource.pause_webhook_before_update
    ]

    # Prevent updates by ignoring server-managed fields that cause drift
    # QuickNode adds these fields in responses but we don't manage them
    ignore_changes = [
      # Ignore the entire data block to prevent drift detection from server-managed fields
      # Real config changes are detected via the hash in the webhook name
      data
    ]
  }

  # Ensure pause/delete happens before Terraform tries to update
  # Also ensure null_resource runs before this is destroyed (for pause on destroy)
  depends_on = [null_resource.pause_webhook_before_update]
}

# Ensure null_resource destroy provisioner runs before restapi_object is destroyed
# This allows the webhook to be paused before deletion
resource "null_resource" "pause_webhook_on_destroy" {
  triggers = {
    webhook_id  = restapi_object.multisig_webhook.id
    script_path = "${path.root}/scripts/manage-quicknode-webhook.sh"
  }

  lifecycle {
    create_before_destroy = false
  }

  # This provisioner will run when the restapi_object is being destroyed
  # It pauses the webhook before the restapi_object destroy provisioner runs
  provisioner "local-exec" {
    when    = destroy
    command = <<-EOT
      WEBHOOK_ID="${self.triggers.webhook_id}"
      # Compute script path dynamically (works for both old and new resources)
      # Find the project root by looking for scripts/manage-quicknode-webhook.sh
      SCRIPT_PATH=""
      CURRENT_DIR="$$(pwd)"
      # Try to find script starting from current directory and going up
      for dir in "$$CURRENT_DIR" "$$(dirname "$$CURRENT_DIR")" "$$(dirname "$$(dirname "$$CURRENT_DIR")")"; do
        if [ -f "$$dir/scripts/manage-quicknode-webhook.sh" ]; then
          SCRIPT_PATH="$$dir/scripts/manage-quicknode-webhook.sh"
          break
        fi
      done

      if [ -z "$$SCRIPT_PATH" ]; then
        echo "Warning: Could not find manage-quicknode-webhook.sh script, skipping pause"
        exit 0
      fi
      
      if [ -n "$WEBHOOK_ID" ] && [ "$WEBHOOK_ID" != "" ] && [ "$WEBHOOK_ID" != "null" ]; then
        echo "Pausing webhook $WEBHOOK_ID before deletion..."
        
        API_KEY="$QUICKNODE_API_KEY"
        if [ -z "$API_KEY" ] || [ "$API_KEY" = "" ]; then
          echo "Warning: QUICKNODE_API_KEY environment variable not set, skipping pause"
          exit 0
        fi
        
        "$$SCRIPT_PATH" pause "$WEBHOOK_ID" "$API_KEY" || true
      else
        echo "Could not determine webhook ID, skipping pause"
      fi
    EOT
  }
}
