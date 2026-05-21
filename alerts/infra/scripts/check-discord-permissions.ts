/**
 * Check Discord bot permissions and identify missing ones.
 *
 * This script checks both server-wide permissions and category-specific permissions
 * (if a category ID is provided). It will also test channel creation in the category
 * and verify that permission syncing (sync_perms_with_category) will work, which is
 * required for Terraform to successfully create Discord channels.
 *
 * Usage:
 *   tsx scripts/check-discord-permissions.ts <BOT_TOKEN> <SERVER_ID> [CATEGORY_ID]
 *
 * Or use environment variables:
 *   export DISCORD_BOT_TOKEN="your-bot-token"
 *   export DISCORD_SERVER_ID="1234567890123456789"
 *   export DISCORD_CATEGORY_ID="1234567890123456789"  # Optional
 *   tsx scripts/check-discord-permissions.ts
 *
 * Or the script will automatically read from terraform.tfvars if no arguments
 * or environment variables are provided. If discord_category_id is found in
 * terraform.tfvars, category-specific checks will be performed automatically.
 *
 * CRITICAL: This script tests permission syncing capability, which is required
 * for Terraform's sync_perms_with_category feature. Without proper category-level
 * MANAGE_CHANNELS permission, Terraform will fail with "Can't sync permissions
 * with category" errors.
 *
 * The script also verifies that the bot can view channels it creates, which is
 * required for Terraform to refresh state. Without VIEW_CHANNEL permission on the
 * category, Terraform will fail with "Failed to fetch channel ... HTTP 403 Forbidden"
 * errors when refreshing existing channels.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as path from "node:path";

// Colors for terminal output
const Colors = {
  RED: "\u001b[0;31m",
  GREEN: "\u001b[0;32m",
  YELLOW: "\u001b[1;33m",
  BLUE: "\u001b[0;34m",
  CYAN: "\u001b[0;36m",
  NC: "\u001b[0m", // No Color
} as const;

// Discord permission flags
const PERMISSIONS = {
  ADMINISTRATOR: 0x8, // 8
  MANAGE_CHANNELS: 0x10, // 16
  MANAGE_ROLES: 0x10000000, // 268435456
  MANAGE_WEBHOOKS: 0x20000000, // 536870912
  VIEW_CHANNEL: 0x400, // 1024
  SEND_MESSAGES: 0x800, // 2048
} as const;

// Required permissions for this project
const REQUIRED_PERMISSIONS: Array<keyof typeof PERMISSIONS> = [
  "MANAGE_CHANNELS",
  "MANAGE_ROLES", // Required for syncing permission overwrites
  "MANAGE_WEBHOOKS",
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
];

interface DiscordUser {
  id: string;
  username: string;
}

interface DiscordGuild {
  id: string;
  name: string;
}

interface DiscordMember {
  roles: string[];
}

interface DiscordRole {
  id: string;
  name: string;
  permissions: string;
}

interface DiscordError {
  message: string;
  code?: number;
}

/**
 * Make an authenticated request to Discord API
 */
function makeRequest<T>(
  url: string,
  token: string,
  method: string = "GET",
  body?: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data) as T);
          } catch (error) {
            reject(new Error(`Failed to parse JSON: ${error}`));
          }
        } else {
          try {
            const error: DiscordError = JSON.parse(data);
            reject(
              new Error(`HTTP ${res.statusCode}: ${error.message || data}`),
            );
          } catch {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        }
      });
    });

    req.on("error", (error) => {
      reject(new Error(`Network error: ${error.message}`));
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

/**
 * Check if a specific permission is granted
 */
function checkPermission(
  permissions: number,
  permName: keyof typeof PERMISSIONS,
): boolean {
  const permFlag = PERMISSIONS[permName];

  // Administrator permission grants all permissions
  if (permissions & PERMISSIONS.ADMINISTRATOR) {
    return true;
  }

  return Boolean(permissions & permFlag);
}

/**
 * Calculate total permissions for the bot based on its roles
 */
function calculateBotPermissions(
  botRoles: string[],
  allRoles: Map<string, DiscordRole>,
  everyonePerms: number,
): number {
  let totalPerms = everyonePerms;

  for (const roleId of botRoles) {
    const role = allRoles.get(roleId);
    if (role) {
      const rolePerms = parseInt(role.permissions, 10);
      totalPerms |= rolePerms;
    }
  }

  return totalPerms;
}

interface DiscordChannel {
  id: string;
  name: string;
  type: number; // 4 = category
  parent_id: string | null;
  permission_overwrites?: Array<{
    id: string;
    type: number; // 0 = role, 1 = member
    allow: string;
    deny: string;
  }>;
}

/**
 * Extract channel ID from a resource instance
 */
function extractIdFromInstance(instance: unknown): string | null {
  if (!instance || typeof instance !== "object") {
    return null;
  }

  const instanceRecord = instance as { attributes?: { id?: unknown } };
  const attrs = instanceRecord.attributes;
  if (attrs && attrs.id) {
    return String(attrs.id);
  }

  return null;
}

/**
 * Extract channel ID from resource attributes
 */
function extractIdFromAttributes(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object") {
    return null;
  }

  const attrs = attributes as { id?: unknown };
  if (attrs.id) {
    return String(attrs.id);
  }

  return null;
}

/**
 * Check if an object represents a discord_text_channel resource
 */
function isDiscordTextChannelResource(obj: Record<string, unknown>): boolean {
  const type = obj.type;
  return (
    type === "discord_text_channel" ||
    (typeof type === "string" && type.includes("discord_text_channel"))
  );
}

/**
 * Extract channel IDs from a resource object
 */
function extractIdsFromResource(
  obj: Record<string, unknown>,
  channelIds: string[],
): void {
  if (!isDiscordTextChannelResource(obj)) {
    return;
  }

  // Handle instances array format
  if (Array.isArray(obj.instances)) {
    for (const instance of obj.instances) {
      const id = extractIdFromInstance(instance);
      if (id) {
        channelIds.push(id);
      }
    }
  }

  // Handle single instance format
  if (obj.attributes) {
    const id = extractIdFromAttributes(obj.attributes);
    if (id) {
      channelIds.push(id);
    }
  }
}

/**
 * Extract channel IDs from resource_changes array
 */
function extractIdsFromResourceChanges(
  resourceChanges: unknown[],
  channelIds: string[],
): void {
  for (const change of resourceChanges) {
    if (!change || typeof change !== "object") {
      continue;
    }

    const changeRecord = change as { type?: unknown };
    if (
      typeof changeRecord.type === "string" &&
      changeRecord.type.includes("discord_text_channel")
    ) {
      const typedChange = change as {
        instances?: Array<{ attributes?: { id?: unknown } }>;
        values?: { id?: unknown };
      };

      if (Array.isArray(typedChange.instances)) {
        for (const instance of typedChange.instances) {
          const id = extractIdFromInstance(instance);
          if (id) {
            channelIds.push(id);
          }
        }
      }

      if (typedChange.values) {
        const id = extractIdFromAttributes(typedChange.values);
        if (id) {
          channelIds.push(id);
        }
      }
    }
  }
}

/**
 * Recursively search for discord_text_channel resources in Terraform state
 */
function extractChannelIds(
  obj: unknown,
  channelIds: string[],
  visited = new WeakSet<object>(),
): void {
  if (!obj || typeof obj !== "object") {
    return;
  }

  // Prevent infinite loops with circular references
  if (visited.has(obj as object)) {
    return;
  }
  visited.add(obj as object);

  const objRecord = obj as Record<string, unknown>;

  // Handle arrays
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractChannelIds(item, channelIds, visited);
    }
    return;
  }

  // Handle resource objects
  extractIdsFromResource(objRecord, channelIds);

  // Handle modules
  if (Array.isArray(objRecord.modules)) {
    for (const module of objRecord.modules) {
      if (module && typeof module === "object" && "resources" in module) {
        extractChannelIds(
          (module as { resources: unknown }).resources,
          channelIds,
          visited,
        );
      }
    }
  }

  // Handle top-level resources
  if (Array.isArray(objRecord.resources)) {
    extractChannelIds(objRecord.resources, channelIds, visited);
  }

  // Handle resource_changes
  if (Array.isArray(objRecord.resource_changes)) {
    extractIdsFromResourceChanges(objRecord.resource_changes, channelIds);
  }

  // Recursively search other properties (excluding already processed ones)
  const processedKeys = new Set([
    "type",
    "instances",
    "attributes",
    "resources",
    "modules",
    "resource_changes",
  ]);

  for (const key in objRecord) {
    if (!processedKeys.has(key)) {
      extractChannelIds(objRecord[key], channelIds, visited);
    }
  }
}

/**
 * Read Discord channel IDs from Terraform state using terraform state pull
 */
function readChannelIdsFromState(): string[] {
  try {
    const scriptDir =
      typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(new URL(import.meta.url).pathname);
    const projectRoot = path.resolve(scriptDir, "..");

    // Use terraform state pull to get the full state JSON
    const stateJsonOutput = execSync("terraform state pull", {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    const state = JSON.parse(stateJsonOutput);
    const channelIds: string[] = [];

    extractChannelIds(state, channelIds);

    // Remove duplicates
    return Array.from(new Set(channelIds));
  } catch {
    // Silently fail - terraform might not be available or state might not be accessible
    return [];
  }
}

/**
 * Read Discord bot token, server ID, and category ID from terraform.tfvars
 */
function readFromTfvars(): {
  botToken: string | null;
  serverId: string | null;
  categoryId: string | null;
} {
  try {
    // Try to find terraform.tfvars relative to the script location
    // __dirname is available in CommonJS, but for ESM we use import.meta.url
    const scriptDir =
      typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(new URL(import.meta.url).pathname);
    const projectRoot = path.resolve(scriptDir, "..");
    const tfvarsPath = path.join(projectRoot, "terraform.tfvars");

    if (!fs.existsSync(tfvarsPath)) {
      return { botToken: null, serverId: null, categoryId: null };
    }

    const content = fs.readFileSync(tfvarsPath, "utf-8");

    // Extract discord_bot_token value (handles both "value" and 'value')
    const botTokenMatch = content.match(
      /^discord_bot_token\s*=\s*["']([^"']+)["']/m,
    );
    const botToken = botTokenMatch ? botTokenMatch[1] : null;

    // Extract discord_server_id value (handles both "value" and 'value')
    const serverIdMatch = content.match(
      /^discord_server_id\s*=\s*["']([^"']+)["']/m,
    );
    const serverId = serverIdMatch ? serverIdMatch[1] : null;

    // Extract discord_category_id value (handles both "value" and 'value')
    const categoryIdMatch = content.match(
      /^discord_category_id\s*=\s*["']([^"']+)["']/m,
    );
    const categoryId = categoryIdMatch ? categoryIdMatch[1] : null;

    return { botToken, serverId, categoryId };
  } catch {
    // Silently fail - we'll fall back to other methods
    return { botToken: null, serverId: null, categoryId: null };
  }
}

/**
 * Calculate effective permissions for a channel/category
 */
function calculateChannelPermissions(
  channel: DiscordChannel,
  botRoles: string[],
  allRoles: Map<string, DiscordRole>,
  everyonePerms: number,
  botId: string,
): number {
  // Start with server-wide permissions
  let perms = calculateBotPermissions(botRoles, allRoles, everyonePerms);

  // Apply channel-specific permission overwrites
  if (channel.permission_overwrites) {
    for (const overwrite of channel.permission_overwrites) {
      // Check if this overwrite applies to the bot
      let applies = false;

      if (overwrite.type === 1 && overwrite.id === botId) {
        // Direct member overwrite
        applies = true;
      } else if (overwrite.type === 0) {
        // Role overwrite - check if bot has this role
        if (botRoles.includes(overwrite.id)) {
          applies = true;
        }
      }

      if (applies) {
        const allow = parseInt(overwrite.allow, 10);
        const deny = parseInt(overwrite.deny, 10);
        perms = (perms & ~deny) | allow;
      }
    }
  }

  return perms;
}

async function main(): Promise<void> {
  // Get bot token and server ID from (in order of priority):
  // 1. Command-line arguments
  // 2. Environment variables
  // 3. terraform.tfvars file
  let botToken = process.argv[2] || process.env.DISCORD_BOT_TOKEN;
  let serverId = process.argv[3] || process.env.DISCORD_SERVER_ID;
  let categoryId = process.argv[4] || process.env.DISCORD_CATEGORY_ID;

  // If not provided, try reading from terraform.tfvars
  if (!botToken || !serverId || !categoryId) {
    const tfvars = readFromTfvars();
    botToken = botToken || tfvars.botToken || undefined;
    serverId = serverId || tfvars.serverId || undefined;
    categoryId = categoryId || tfvars.categoryId || undefined;
  }

  if (!botToken || !serverId) {
    console.error(`${Colors.RED}Error: Missing required arguments${Colors.NC}`);
    console.log("\nUsage:");
    console.log(
      `  tsx ${process.argv[1]} <BOT_TOKEN> <SERVER_ID> [CATEGORY_ID]`,
    );
    console.log("\nOr use environment variables:");
    console.log('  export DISCORD_BOT_TOKEN="your-bot-token"');
    console.log('  export DISCORD_SERVER_ID="1234567890123456789"');
    console.log('  export DISCORD_CATEGORY_ID="1234567890123456789"');
    console.log(`  tsx ${process.argv[1]}`);
    console.log(
      "\nOr the script will automatically read from terraform.tfvars",
    );
    console.log("  if no arguments or environment variables are provided.");
    process.exit(1);
  }

  const apiBase = "https://discord.com/api/v10";

  console.log(
    `${Colors.BLUE}🔍 Checking Discord bot permissions...${Colors.NC}`,
  );

  // Get bot user info
  let botInfo: DiscordUser;
  try {
    botInfo = await makeRequest<DiscordUser>(`${apiBase}/users/@me`, botToken);
  } catch (error) {
    console.error(
      `${Colors.RED}❌ Error: Failed to authenticate bot token${Colors.NC}`,
    );
    console.error(
      `   ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // Get guild (server) member info
  let memberInfo: DiscordMember;
  try {
    memberInfo = await makeRequest<DiscordMember>(
      `${apiBase}/guilds/${serverId}/members/${botInfo.id}`,
      botToken,
    );
  } catch (error) {
    console.error(
      `${Colors.RED}❌ Error: Failed to fetch member info${Colors.NC}`,
    );
    console.error(
      `   ${error instanceof Error ? error.message : String(error)}`,
    );
    console.log(`${Colors.YELLOW}Possible issues:${Colors.NC}`);
    console.log("  - Bot is not in the server (invite it first)");
    console.log("  - Server ID is incorrect");
    console.log("  - Bot token doesn't have access to this server");
    process.exit(1);
  }

  // Get guild info
  try {
    await makeRequest<DiscordGuild>(`${apiBase}/guilds/${serverId}`, botToken);
  } catch {
    // Silently fail - not critical
  }

  // Get bot's roles
  const botRoles = memberInfo.roles || [];

  // Get all roles in the server
  let allRolesData: DiscordRole[];
  try {
    allRolesData = await makeRequest<DiscordRole[]>(
      `${apiBase}/guilds/${serverId}/roles`,
      botToken,
    );
  } catch (error) {
    console.error(`${Colors.RED}❌ Error: Failed to fetch roles${Colors.NC}`);
    console.error(
      `   ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // Find @everyone role and calculate permissions
  const everyoneRole = allRolesData.find((role) => role.id === serverId);

  if (!everyoneRole) {
    console.error(
      `${Colors.RED}❌ Error: Could not find @everyone role${Colors.NC}`,
    );
    process.exit(1);
  }

  const everyonePerms = parseInt(everyoneRole.permissions, 10);
  const allRolesMap = new Map<string, DiscordRole>();
  for (const role of allRolesData) {
    allRolesMap.set(role.id, role);
  }

  const totalPerms = calculateBotPermissions(
    botRoles,
    allRolesMap,
    everyonePerms,
  );

  // Check if bot has administrator permission
  const hasAdmin = checkPermission(totalPerms, "ADMINISTRATOR");

  if (hasAdmin) {
    console.log(
      `${Colors.GREEN}✅ Bot has Administrator permission - all checks passed!${Colors.NC}\n`,
    );
    process.exit(0);
  }

  // Check each required permission
  const missingPerms: Array<keyof typeof PERMISSIONS> = [];
  const hasPerms: Array<keyof typeof PERMISSIONS> = [];

  for (const permName of REQUIRED_PERMISSIONS) {
    const hasPerm = checkPermission(totalPerms, permName);
    if (hasPerm) {
      hasPerms.push(permName);
    } else {
      missingPerms.push(permName);
    }
  }

  // Show server-wide permission summary
  if (missingPerms.length === 0) {
    console.log(
      `${Colors.GREEN}✓ Server-wide permissions: ${hasPerms.join(", ")}${Colors.NC}`,
    );
  } else {
    console.log(
      `${Colors.RED}✗ Missing server-wide permissions: ${missingPerms.join(", ")}${Colors.NC}`,
    );
  }

  // Check category-specific permissions if category ID is provided
  let categoryIssues = false;
  let categoryName: string | null = null;
  if (categoryId) {
    console.log();
    console.log(`${Colors.BLUE}📁 Category: ${categoryId}${Colors.NC}`);

    try {
      // Fetch category information
      const category = await makeRequest<DiscordChannel>(
        `${apiBase}/channels/${categoryId}`,
        botToken,
      );
      categoryName = category.name;

      // Verify it's actually a category
      if (category.type !== 4) {
        console.warn(
          `${Colors.YELLOW}⚠ Warning: Channel ${categoryId} is not a category (type: ${category.type})${Colors.NC}`,
        );
      }

      // Calculate bot's permissions on this category
      const categoryPerms = calculateChannelPermissions(
        category,
        botRoles,
        allRolesMap,
        everyonePerms,
        botInfo.id,
      );

      // Check category permissions
      const categoryViewPerm = checkPermission(categoryPerms, "VIEW_CHANNEL");
      const categoryManagePerm = checkPermission(
        categoryPerms,
        "MANAGE_CHANNELS",
      );
      const categoryManageRoles = checkPermission(
        categoryPerms,
        "MANAGE_ROLES",
      );

      const categoryPermsList: string[] = [];
      if (categoryViewPerm) categoryPermsList.push("VIEW_CHANNEL");
      if (categoryManagePerm) categoryPermsList.push("MANAGE_CHANNELS");
      if (categoryManageRoles) categoryPermsList.push("MANAGE_ROLES");

      if (categoryViewPerm && categoryManagePerm && categoryManageRoles) {
        console.log(
          `${Colors.GREEN}✓ Category permissions: ${categoryPermsList.join(", ")}${Colors.NC}`,
        );
      } else {
        const missing: string[] = [];
        if (!categoryViewPerm) missing.push("VIEW_CHANNEL");
        if (!categoryManagePerm) missing.push("MANAGE_CHANNELS");
        if (!categoryManageRoles) missing.push("MANAGE_ROLES");
        console.log(
          `${Colors.RED}✗ Missing category permissions: ${missing.join(", ")}${Colors.NC}`,
        );
        if (missing.includes("MANAGE_ROLES")) {
          console.log(
            `${Colors.YELLOW}   ⚠ MANAGE_ROLES is required to sync permission overwrites${Colors.NC}`,
          );
        }
        categoryIssues = true;
      }

      // Test if bot can list channels in the category (simulates Terraform refresh)
      try {
        const allChannels = await makeRequest<DiscordChannel[]>(
          `${apiBase}/guilds/${serverId}/channels`,
          botToken,
        );
        const categoryChannels = allChannels.filter(
          (ch) => ch.parent_id === categoryId,
        );
        const visibleChannels = categoryChannels.filter((ch) => {
          const channelPerms = calculateChannelPermissions(
            ch,
            botRoles,
            allRolesMap,
            everyonePerms,
            botInfo.id,
          );
          return checkPermission(channelPerms, "VIEW_CHANNEL");
        });

        if (categoryChannels.length > 0) {
          if (visibleChannels.length === categoryChannels.length) {
            // Silent success - no issues
          } else {
            const hiddenCount =
              categoryChannels.length - visibleChannels.length;
            console.log(
              `${Colors.RED}✗ Cannot view ${hiddenCount} of ${categoryChannels.length} channel(s) in category${Colors.NC}`,
            );
            categoryIssues = true;
          }
        }
      } catch {
        // Silent fail - not critical
      }

      // CRITICAL: Test if bot can fetch channels from Terraform state by ID
      const stateChannelIds = readChannelIdsFromState();
      if (stateChannelIds.length > 0) {
        const inaccessibleChannels: Array<{
          id: string;
          error: string;
          name?: string;
        }> = [];
        const accessibleChannels: Array<{
          id: string;
          name: string;
          hasDenyOverride: boolean;
          channel?: DiscordChannel;
        }> = [];

        // First, get all channels the bot can see to cross-reference
        let visibleChannelIds: Set<string> = new Set();
        try {
          const allChannels = await makeRequest<DiscordChannel[]>(
            `${apiBase}/guilds/${serverId}/channels`,
            botToken,
          );
          visibleChannelIds = new Set(
            allChannels.map((ch) => ch.id).filter(Boolean),
          );
        } catch {
          // If we can't list channels, continue anyway
        }

        for (const channelId of stateChannelIds) {
          try {
            const channel = await makeRequest<DiscordChannel>(
              `${apiBase}/channels/${channelId}`,
              botToken,
            );
            // Verify it's in the expected category
            if (channel.parent_id !== categoryId) {
              console.log(
                `${Colors.YELLOW}  ⚠ Channel ${channelId} (${channel.name}) is not in the expected category${Colors.NC}`,
              );
            }

            // Check if this channel has permission overwrites that deny VIEW_CHANNEL
            let hasDenyOverride = false;
            if (channel.permission_overwrites) {
              for (const overwrite of channel.permission_overwrites) {
                let applies = false;
                if (overwrite.type === 1 && overwrite.id === botInfo.id) {
                  applies = true;
                } else if (
                  overwrite.type === 0 &&
                  botRoles.includes(overwrite.id)
                ) {
                  applies = true;
                }

                if (applies) {
                  const deny = parseInt(overwrite.deny, 10);
                  if (deny & PERMISSIONS.VIEW_CHANNEL) {
                    hasDenyOverride = true;
                    break;
                  }
                }
              }
            }

            accessibleChannels.push({
              id: channelId,
              name: channel.name,
              hasDenyOverride,
              channel,
            });
          } catch (fetchError) {
            const errorMessage =
              fetchError instanceof Error
                ? fetchError.message
                : String(fetchError);
            const is403 =
              errorMessage.includes("403") ||
              errorMessage.includes("Missing Access") ||
              errorMessage.includes("50001");

            if (is403) {
              // Check if this channel appears in the visible channels list
              const isInVisibleList = visibleChannelIds.has(channelId);
              inaccessibleChannels.push({
                id: channelId,
                error: errorMessage,
                name: isInVisibleList
                  ? "(visible in list but can't fetch by ID)"
                  : undefined,
              });
            } else {
              console.log(
                `${Colors.YELLOW}  ⚠ Could not fetch channel ${channelId}: ${errorMessage}${Colors.NC}`,
              );
            }
          }
        }

        // Check if accessible channels have permission overwrites that differ from category
        const unsyncedChannels: Array<{
          id: string;
          name: string;
          reason: string;
        }> = [];

        if (accessibleChannels.length > 0) {
          // Get category permission overwrites for comparison
          const categoryOverwrites = category.permission_overwrites || [];
          const categoryOverwriteMap = new Map<
            string,
            {
              allow: number;
              deny: number;
              type: number;
            }
          >();
          for (const overwrite of categoryOverwrites) {
            categoryOverwriteMap.set(overwrite.id, {
              allow: parseInt(overwrite.allow, 10),
              deny: parseInt(overwrite.deny, 10),
              type: overwrite.type,
            });
          }

          // Check each accessible channel
          for (const chInfo of accessibleChannels) {
            // Use cached channel data if available, otherwise fetch
            let channel = chInfo.channel;
            if (!channel) {
              try {
                channel = await makeRequest<DiscordChannel>(
                  `${apiBase}/channels/${chInfo.id}`,
                  botToken,
                );
              } catch {
                // Skip if we can't fetch the channel
                continue;
              }
            }

            try {
              if (!channel.permission_overwrites) {
                // Channel has no overwrites, which is fine if category has none
                if (categoryOverwrites.length > 0) {
                  unsyncedChannels.push({
                    id: chInfo.id,
                    name: chInfo.name,
                    reason:
                      "Channel has no permission overwrites but category does",
                  });
                }
                continue;
              }

              // Check if channel has overwrites that differ from category
              const channelOverwriteMap = new Map<
                string,
                {
                  allow: number;
                  deny: number;
                  type: number;
                }
              >();
              for (const overwrite of channel.permission_overwrites) {
                channelOverwriteMap.set(overwrite.id, {
                  allow: parseInt(overwrite.allow, 10),
                  deny: parseInt(overwrite.deny, 10),
                  type: overwrite.type,
                });
              }

              // Check for differences
              const allOverwriteIds = new Set([
                ...categoryOverwriteMap.keys(),
                ...channelOverwriteMap.keys(),
              ]);

              for (const overwriteId of allOverwriteIds) {
                const categoryOverwrite = categoryOverwriteMap.get(overwriteId);
                const channelOverwrite = channelOverwriteMap.get(overwriteId);

                // If category has an overwrite but channel doesn't, or vice versa
                if (
                  (categoryOverwrite && !channelOverwrite) ||
                  (!categoryOverwrite && channelOverwrite)
                ) {
                  unsyncedChannels.push({
                    id: chInfo.id,
                    name: chInfo.name,
                    reason: `Permission overwrite mismatch for ${overwriteId === botInfo.id ? "bot" : overwriteId === serverId ? "@everyone" : `role ${overwriteId}`}`,
                  });
                  break;
                }

                // If both exist but differ
                if (categoryOverwrite && channelOverwrite) {
                  const viewChannelDeny = PERMISSIONS.VIEW_CHANNEL;
                  const categoryDeniesView =
                    (categoryOverwrite.deny & viewChannelDeny) !== 0;
                  const channelDeniesView =
                    (channelOverwrite.deny & viewChannelDeny) !== 0;

                  if (categoryDeniesView !== channelDeniesView) {
                    unsyncedChannels.push({
                      id: chInfo.id,
                      name: chInfo.name,
                      reason: `VIEW_CHANNEL deny override differs from category`,
                    });
                    break;
                  }
                }
              }
            } catch {
              // Skip if there's an error processing the channel
              continue;
            }
          }
        }

        // Report unsynced channels
        if (unsyncedChannels.length > 0) {
          console.log(
            `${Colors.YELLOW}⚠ ${unsyncedChannels.length} channel(s) not synced to category:${Colors.NC}`,
          );
          for (const ch of unsyncedChannels) {
            console.log(`   ${Colors.YELLOW}• ${ch.name}${Colors.NC}`);
          }
          console.log(
            `${Colors.CYAN}💡 Fix: Run 'terraform apply' to sync permissions${Colors.NC}`,
          );
          categoryIssues = true;
        }

        if (inaccessibleChannels.length > 0) {
          console.log(
            `${Colors.RED}✗ Cannot fetch ${inaccessibleChannels.length} of ${stateChannelIds.length} channel(s) from Terraform state${Colors.NC}`,
          );
          for (const { id } of inaccessibleChannels) {
            console.log(`   ${Colors.RED}• ${id}${Colors.NC}`);
          }
          console.log(
            `${Colors.CYAN}💡 Fix: Run 'terraform taint' on these channels, then 'terraform apply'${Colors.NC}`,
          );
          categoryIssues = true;
        }
      }

      // Test channel creation and permission sync (silent if successful)
      try {
        const testChannelName = `test-channel-${Date.now()}`;
        const testChannel = await makeRequest<DiscordChannel>(
          `${apiBase}/guilds/${serverId}/channels`,
          botToken,
          "POST",
          JSON.stringify({
            name: testChannelName,
            type: 0,
            parent_id: categoryId,
          }),
        );

        // Test if bot can view the channel it created
        try {
          await makeRequest<DiscordChannel>(
            `${apiBase}/channels/${testChannel.id}`,
            botToken,
          );
        } catch (viewError) {
          const viewErrorMessage =
            viewError instanceof Error ? viewError.message : String(viewError);
          if (
            viewErrorMessage.includes("403") ||
            viewErrorMessage.includes("Missing Access")
          ) {
            console.log(
              `${Colors.RED}✗ Cannot view channels after creation (HTTP 403)${Colors.NC}`,
            );
            categoryIssues = true;
          }
        }

        // Test permission sync - this is what Terraform actually does
        // It copies the category's permission overwrites to the channel
        try {
          // Get category permission overwrites
          const categoryOverwrites = category.permission_overwrites || [];

          // Try to sync by setting the channel's overwrites to match the category
          await makeRequest(
            `${apiBase}/channels/${testChannel.id}`,
            botToken,
            "PATCH",
            JSON.stringify({
              permission_overwrites: categoryOverwrites.map((overwrite) => ({
                id: overwrite.id,
                type: overwrite.type,
                allow: overwrite.allow,
                deny: overwrite.deny,
              })),
            }),
          );
        } catch (syncError) {
          const syncErrorMessage =
            syncError instanceof Error ? syncError.message : String(syncError);
          const isSyncError =
            syncErrorMessage.includes("403") ||
            syncErrorMessage.includes("Missing Access") ||
            syncErrorMessage.includes("Missing Permissions") ||
            syncErrorMessage.includes("sync") ||
            syncErrorMessage.includes("50013");

          if (isSyncError) {
            console.log(
              `${Colors.RED}✗ Cannot sync permissions with category${Colors.NC}`,
            );
            console.log(
              `${Colors.YELLOW}   Error: ${syncErrorMessage}${Colors.NC}`,
            );
            console.log(
              `${Colors.CYAN}💡 The bot needs MANAGE_CHANNELS and MANAGE_ROLES on the category${Colors.NC}`,
            );
            console.log(
              `${Colors.CYAN}   MANAGE_ROLES is required to modify permission overwrites${Colors.NC}`,
            );
            categoryIssues = true;
          }
        }

        // Clean up test channel
        try {
          await makeRequest(
            `${apiBase}/channels/${testChannel.id}`,
            botToken,
            "DELETE",
          );
        } catch (cleanupError) {
          const cleanupErrorMessage =
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError);
          console.log(
            `${Colors.YELLOW}⚠ Warning: Could not delete test channel ${testChannel.id}: ${cleanupErrorMessage}${Colors.NC}`,
          );
          console.log(
            `${Colors.CYAN}💡 Please manually delete the test channel if it still exists${Colors.NC}`,
          );
        }
      } catch {
        console.log(
          `${Colors.RED}✗ Cannot create channels in category${Colors.NC}`,
        );
        categoryIssues = true;
      }

      if (categoryIssues) {
        console.log();
        console.log(
          `${Colors.YELLOW}📋 Fix: Grant VIEW_CHANNEL, MANAGE_CHANNELS, and MANAGE_ROLES on category "${categoryName || categoryId}"${Colors.NC}`,
        );
        console.log(
          `${Colors.CYAN}   MANAGE_ROLES is required to sync permission overwrites${Colors.NC}`,
        );
        console.log(
          `${Colors.CYAN}   Or grant Administrator permission to bot role${Colors.NC}`,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const is403 =
        errorMessage.includes("403") || errorMessage.includes("Missing Access");

      if (is403) {
        console.error(
          `${Colors.RED}❌ Cannot access category (HTTP 403)${Colors.NC}`,
        );
        console.log(
          `${Colors.YELLOW}📋 Fix: Grant VIEW_CHANNEL and MANAGE_CHANNELS on category, or grant Administrator${Colors.NC}`,
        );
      } else {
        console.error(
          `${Colors.RED}❌ Error checking category: ${errorMessage}${Colors.NC}`,
        );
      }

      categoryIssues = true;
    }
  }

  // Summary
  console.log();
  if (missingPerms.length === 0 && !categoryIssues) {
    console.log(
      `${Colors.GREEN}✅ All checks passed! Ready for Terraform apply.${Colors.NC}\n`,
    );
    process.exit(0);
  }

  // Show issues summary
  if (missingPerms.length > 0) {
    console.log(
      `${Colors.RED}❌ Missing server-wide permissions: ${missingPerms.join(", ")}${Colors.NC}`,
    );
    console.log(
      `${Colors.CYAN}💡 Fix: Grant Administrator or individual permissions to bot role${Colors.NC}\n`,
    );
  }

  if (categoryIssues) {
    console.log(
      `${Colors.RED}❌ Category permission issues detected (see above)${Colors.NC}\n`,
    );
  }

  process.exit(1);
}

main().catch((error) => {
  console.error(`${Colors.RED}Unexpected error:${Colors.NC}`, error);
  process.exit(1);
});
