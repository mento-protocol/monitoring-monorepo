# QuickNode Webhook State Management

## Problem

QuickNode webhooks can get out of sync with Terraform state, causing `404` errors when Terraform tries to update webhooks that no longer exist. This happens because:

1. **QuickNode doesn't support PUT/PATCH updates** - Webhooks must be deleted and recreated to change configuration
2. **Webhooks can be deleted outside Terraform** - Manual deletion or API issues can remove webhooks while Terraform still has them in state
3. **The restapi provider attempts updates by default** - Even without `update_path`, the provider may try to update resources
4. **Race conditions with provisioners** - Terraform plans updates before provisioners run to delete old webhooks

## Improvements Made

### 1. Force Recreation Instead of Updates

```hcl
resource "restapi_object" "multisig_webhook" {
  # ...

  # CRITICAL: Force recreation instead of updates
  update_path   = ""
  update_method = "POST" # Invalid method for updates - forces recreation

  # Delete old before creating new to avoid conflicts
  create_before_destroy = false
}
```

**Why:** This prevents the restapi provider from attempting PUT/PATCH operations that QuickNode doesn't support.

### 2. Webhook Name Includes Config Hash

```hcl
data = jsonencode({
  name = "${var.webhook_name}-${substr(local.webhook_data_hash, 0, 8)}"
  # ...
})
```

**Why:** When configuration changes, the webhook name changes, forcing Terraform to recognize it as a completely new resource requiring recreation (not update).

### 3. Automated State Repair Script

A new script [`scripts/fix-webhook-state.sh`](../scripts/fix-webhook-state.sh) helps detect and fix state drift:

```bash
# Check webhook state and fix issues
./scripts/fix-webhook-state.sh
```

**What it does:**

- Lists all webhook resources in Terraform state
- Checks if each webhook exists in QuickNode
- Identifies webhooks in state that don't exist remotely
- Offers to remove orphaned webhooks from state
- Provides guidance on next steps

### 4. Debug Mode Enabled

```hcl
debug = true
```

**Why:** Helps troubleshoot API communication issues by logging request/response details.

## How to Fix Current 404 Errors

### Immediate Fix

If you're getting 404 errors, the webhook in your state doesn't exist in QuickNode. Remove it from state:

```bash
# Remove the orphaned webhook from state
terraform state rm -lock=false 'module.onchain_event_listeners["<network>"].restapi_object.multisig_webhook'

# Also remove the helper resources
terraform state rm -lock=false \
  'module.onchain_event_listeners["<network>"].null_resource.pause_webhook_before_update' \
  'module.onchain_event_listeners["<network>"].null_resource.pause_webhook_on_destroy'

# Plan to verify it will create (not update)
terraform plan -lock=false

# Apply to create the new webhook
terraform apply -lock=false
```

Replace `<network>` with your network key (e.g., `celo`, `ethereum`, `base`).

### Automated Fix (Requires Network Access)

Use the state repair script (automatically reads API key from `terraform.tfvars`):

```bash
# Run the repair script
./scripts/fix-webhook-state.sh

# Follow the prompts to remove orphaned webhooks
# Then run terraform apply to recreate them
```

**Note:**

- The script automatically reads `quicknode_api_key` from `terraform.tfvars`
- Requires network access to query QuickNode's API
- If network access isn't available, use the immediate fix above

## Best Practices

### 1. Always Check State Before Applying

Before running `terraform apply`, check if any webhooks are missing:

```bash
./scripts/fix-webhook-state.sh
```

### 2. Use `-lock=false` Carefully

The provisioners use `-lock=false` to avoid deadlocks, but this can cause issues in team environments. Consider:

- Running Terraform from a CI/CD pipeline with proper locking
- Coordinating with team members before applying changes
- Using Terraform Cloud or backend locking

### 3. Monitor Webhook Status

Periodically verify webhooks exist in QuickNode:

```bash
# List all webhooks via API
curl -H "x-api-key: $QUICKNODE_API_KEY" \
  https://api.quicknode.com/webhooks/rest/v1/webhooks
```

### 4. Handle Failures Gracefully

If `terraform apply` fails with a 404:

1. **Don't panic** - This is expected when webhooks are deleted externally
2. **Run the repair script** to identify and fix state drift
3. **Re-apply** to recreate missing webhooks

## Architecture Notes

### Why Not Use `create_before_destroy = true`?

QuickNode webhook names must be unique. With `create_before_destroy = true`, Terraform would try to create the new webhook before deleting the old one, causing a name conflict since we include a hash in the name.

Setting `create_before_destroy = false` ensures:

1. Old webhook is deleted first (or removed from state if already gone)
2. New webhook is created with the same base name + new hash
3. No conflicts occur

### The Role of `null_resource.pause_webhook_before_update`

This resource triggers when webhook configuration changes:

1. **Triggers** include the webhook data hash
2. When hash changes, the resource is **replaced** (not updated)
3. On replacement, a **provisioner** runs to:
   - Find the old webhook ID in state
   - Pause it via API (required before deletion)
   - Delete it via API
   - Remove it from Terraform state

4. The `restapi_object.multisig_webhook` has `replace_triggered_by = [null_resource.pause_webhook_before_update]`
5. This forces the webhook to be replaced when the null_resource is replaced

**Limitation:** This approach has race conditions because Terraform plans before provisioners run. The improvements above mitigate this by:

- Making updates impossible (forcing recreation)
- Using webhook name hashing to force Terraform to recognize changes as requiring recreation

## Troubleshooting

### Error: "unexpected response code '404'"

**Cause:** Webhook in state doesn't exist in QuickNode

**Fix:**

```bash
terraform state rm 'module.onchain_event_listeners["<network>"].restapi_object.multisig_webhook'
terraform apply
```

### Error: "name already exists"

**Cause:** Trying to create a webhook with a name that already exists

**Fix:**

```bash
# List existing webhooks
curl -H "x-api-key: $QUICKNODE_API_KEY" \
  https://api.quicknode.com/webhooks/rest/v1/webhooks | jq '.[] | {id, name}'

# Delete the conflicting webhook
curl -X DELETE -H "x-api-key: $QUICKNODE_API_KEY" \
  https://api.quicknode.com/webhooks/rest/v1/webhooks/<webhook-id>

# Then apply again
terraform apply
```

### Webhook exists but Terraform wants to recreate it

**Cause:** Webhook configuration hash changed, triggering recreation

**This is normal behavior.** QuickNode doesn't support updates, so any configuration change requires:

1. Delete old webhook
2. Create new webhook

The hash-based naming ensures Terraform recognizes this correctly.

## Future Improvements

Consider these enhancements:

1. **Data source validation** - Add a data source to check webhook existence before operations
2. **External state reconciliation** - Use an external data source to sync state with QuickNode API
3. **Retry logic** - Add retry logic for transient API failures
4. **State refresh automation** - Automatically detect and fix drift during apply
5. **Move away from provisioners** - Replace shell scripts with Terraform-native solutions when available

## References

- [QuickNode Webhooks REST API](https://www.quicknode.com/docs/webhooks) (Note: Specific REST API docs may have moved)
- [Terraform restapi Provider](https://registry.terraform.io/providers/Mastercard/restapi/latest/docs)
- [Terraform Provisioners](https://www.terraform.io/docs/language/resources/provisioners/syntax.html)
