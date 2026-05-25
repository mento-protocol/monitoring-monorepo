output "webhook_id" {
  description = "QuickNode webhook ID"
  value       = restapi_object.multisig_webhook.id
}

output "webhook_endpoint" {
  description = "Webhook endpoint URL"
  value       = var.webhook_endpoint_url
}

output "webhook_name" {
  description = "Webhook name"
  value       = var.webhook_name
}

