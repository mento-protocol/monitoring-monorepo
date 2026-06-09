# Adding New Events to Governance Watchdog

## Overview

The Governance Watchdog uses a centralized event configuration system that makes adding new blockchain events straightforward. All event logic is organized in [`src/events/`](src/events/), with a single source of truth in [`src/events/configs.ts`](src/events/configs.ts).

The event system is built around these core components:

- **Event Configs** ([`src/events/configs.ts`](src/events/configs.ts)): Single source of truth for all event configurations
- **Event Types** ([`src/events/types.ts`](src/events/types.ts)): TypeScript enums, interfaces, and type definitions
- **Event Registry** ([`src/events/registry.ts`](src/events/registry.ts)): Automatically registers all events from configs
- **Event Handlers** ([`src/events/event-handler-factory.ts`](src/events/event-handler-factory.ts)): Generic handler that eliminates code duplication
- **Event Validators** ([`src/events/event-validator-factory.ts`](src/events/event-validator-factory.ts)): Reusable validation logic
- **Message Builders** ([`src/event-notifications/`](src/event-notifications/)): Discord and Telegram message composition

## Complete Workflow for Adding a New Blockchain Event

Adding a new event involves two major parts: setting up the QuickNode webhook to capture the blockchain event, and implementing the TypeScript event handler to process and send notifications.

### Part 1: Set Up QuickNode Webhook and Filter Function

#### 1. Create a Temporary Webhook Manually

Go to the [QuickNode Webhooks Dashboard](https://dashboard.quicknode.com/webhooks) and create a new webhook manually. This temporary webhook will help you develop and test your filter function.

**Configuration:**

- **Network**: Select the appropriate blockchain network (e.g., Celo Mainnet)
- **Webhook URL**: Point to your deployed cloud function URL (get it via `terraform -chdir=infra output function_uri`)
- **Event Type**: Select the event type you want to monitor (e.g., logs, blocks)
- **Filter Function**: Start with a basic filter, you'll develop this in the next steps

#### 2. Develop the Filter Function

Create or update the filter function in [`infra/quicknode-filter-functions/`](infra/quicknode-filter-functions/):

```javascript
// Example: infra/quicknode-filter-functions/governor.js
function main(data) {
  // Decode the event using the contract ABI
  const decoded = evmAbiFilter(data, {
    // Your contract ABI
    abi: [...],
    // Filter criteria
    address: "0xYourContractAddress",
    eventName: "YourEventName",
  });

  // Apply any additional filtering logic
  if (decoded && decoded.length > 0) {
    return decoded;
  }

  return null;
}
```

**Deploy the updated filter to QuickNode** using the deploy script:

```bash
# Deploy a specific webhook
./bin/deploy-quicknode-filter.sh --webhook healthcheck   # SortedOracles
./bin/deploy-quicknode-filter.sh --webhook governor      # MentoGovernor

# Deploy both
./bin/deploy-quicknode-filter.sh
```

The deploy script reads the ABI and contract addresses from the `/* template: evmAbiFilter ... */` comment header at the top of each filter file and applies the update live via `PATCH /webhooks/{id}/template/evmAbiFilterGo` (no downtime required).

> **Note:** The old `npm run dev:webhook:*` scripts and `bin/update-quicknode-filter.js` are legacy — they updated `infra/quicknode.tf` which is never applied to live webhooks (`ignore_all_server_changes = true`). Use `deploy-quicknode-filter.sh` instead.

#### 3. Test the Filter Function with Real Blockchain Data

Find a real transaction that emitted the event you're interested in:

1. **Find a transaction** with your event on a blockchain explorer (e.g., [Celoscan](https://celoscan.io/))
2. **Get the block number** from that transaction
3. **Test the filter function** against that block in the QuickNode dashboard:
   - Go to your webhook in the [QuickNode Webhooks Dashboard](https://dashboard.quicknode.com/webhooks)
   - Click "Test Webhook"
   - Enter the block number
   - Verify that your filter function returns the expected event data

#### 4. Create a Fixture from the Real Response

Once your filter function works correctly:

1. Copy the full response from QuickNode (the decoded event data)
2. Create a new fixture file in [`src/events/fixtures/`](src/events/fixtures/)
3. Format it to match the QuickNode webhook payload structure:

```json
{
  "result": [
    {
      // Paste the real event data from QuickNode here
      "address": "0x...",
      "blockHash": "0x...",
      "blockNumber": "...",
      "name": "YourEventName"
      // ... all other fields from the real response
    }
  ]
}
```

**Pro tip:** Using real data ensures your fixture accurately represents what QuickNode will send in production.

#### 5. Clean Up and Make Permanent

1. **Delete the temporary test webhook** from the [QuickNode Webhooks Dashboard](https://dashboard.quicknode.com/webhooks) (the one you created manually for testing).

2. **Update the filter file comment header** with your final ABI and contract address:

   ```js
   /*
   template: evmAbiFilter
   abi: [{...your trimmed ABI events...}]
   contracts: 0xYourContractAddress
   */
   ```

   Keep only the events your handler actually uses — this reduces Cloud Function invocation volume.

3. **Deploy to the permanent webhook** via:

   ```bash
   ./bin/deploy-quicknode-filter.sh --webhook <healthcheck|governor>
   ```

   > **Note:** Terraform (`infra/quicknode.tf`) manages webhook _creation_ but cannot update filter configuration on existing webhooks (`ignore_all_server_changes = true`). All filter updates go through `bin/deploy-quicknode-filter.sh`.

### Part 2: Implement TypeScript Event Handler

Now that you have the webhook set up and a real fixture, implement the TypeScript code to handle the event.

## Step-by-Step Guide

### 1. Define the Event Type and Interface

First, add your event to the type system in [`src/events/types.ts`](src/events/types.ts):

```typescript
// 1a. Add to the EventType enum
export enum EventType {
  ProposalCreated = "ProposalCreated",
  ProposalQueued = "ProposalQueued",
  // ... existing events ...
  YourNewEvent = "YourNewEvent", // Add your event here
}

// 1b. Create an interface for your event's data
export interface YourNewEventEvent {
  name: EventType.YourNewEvent;
  // Add the fields specific to your event
  // These should match what QuickNode sends in the webhook payload
  someField: string;
  anotherField: bigint;
  optionalField?: `0x${string}`;
}

// 1c. Add the mapping to EventTypeMap
export interface EventTypeMap {
  [EventType.ProposalCreated]: ProposalCreatedEvent;
  // ... existing mappings ...
  [EventType.YourNewEvent]: YourNewEventEvent; // Add your mapping here
}
```

**Note:** The `ValidateEventTypeMap` type helper will give you a compile-time error if you forget to add your event to the `EventTypeMap`. This ensures type safety across the entire system.

### 2. Add Event Configuration

Add a complete configuration for your event in [`src/events/configs.ts`](src/events/configs.ts):

```typescript
export const EVENT_CONFIGS = {
  // ... existing configs ...

  // ===================================================================
  // YOUR NEW EVENT
  // ===================================================================
  [EventType.YourNewEvent]: {
    eventType: EventType.YourNewEvent,

    // Define validation rules
    validateEvent: createEventValidator<QuicknodeEvent & YourNewEventEvent>({
      requiredFields: ["someField", "anotherField"],
      // Optional: Add custom validation logic
      additionalValidation: (eventObj: Record<string, unknown>) => {
        // Return true if valid, false otherwise
        return typeof eventObj.someField === "string";
      },
    }),

    // Define Discord message composition
    getDiscordMessage: (event: QuicknodeEvent & YourNewEventEvent) => {
      return new DiscordMessageBuilder(
        {
          color: 0x4caf50, // Choose your color (hex value)
          title: eventTypeToTitle(EventType.YourNewEvent),
        },
        "A descriptive message about what happened.",
      )
        .addProposalLink(event.proposalId) // Add relevant fields
        .addTransactionLink(event.transactionHash, "Action")
        .build();
    },

    // Define Telegram message composition
    getTelegramMessage: (event: QuicknodeEvent & YourNewEventEvent) => {
      return new TelegramMessageBuilder(
        "A descriptive message about what happened.",
      )
        .addProposalLink(event.proposalId) // Add relevant fields
        .addTransactionLink(event.transactionHash, "Action");
    },

    // Choose an emoji for this event type
    emoji: "🎉",

    // Choose deduplication strategy
    deduplicationStrategy: "proposalId", // or "transactionHash", "rateFeedId", "custom"
  } as EventConfig<QuicknodeEvent & YourNewEventEvent>,
} as const;
```

**That's it!** The event will be automatically registered by [`src/events/registry.ts`](src/events/registry.ts). No need to manually register handlers.

### 3. Available Message Builder Methods

The message builders ([`DiscordMessageBuilder`](src/event-notifications/message-builder.discord.ts) and [`TelegramMessageBuilder`](src/event-notifications/message-builder.telegram.ts)) provide several helper methods:

**Discord:**

```typescript
new DiscordMessageBuilder({ color: 0x4caf50, title: "Title" }, "Description")
  .addProposalLink(proposalId)
  .addProposerLink(proposerAddress)
  .addTimelockId(timelockId)
  .addExecutionTime(eta)
  .addTransactionLink(txHash, "Label")
  .addField("Custom Field", "Custom Value", inline)
  .build(); // Returns { content: string, embed: EmbedBuilder }
```

**Telegram:**

```typescript
new TelegramMessageBuilder("Main message text")
  .addTitle("Title") // Optional, defaults to event type
  .addProposalLink(proposalId)
  .addProposerLink(proposerAddress)
  .addTimelockId(timelockId)
  .addExecutionTime(eta)
  .addTransactionLink(txHash, "Label")
  .addField("Label", "Value or URL")
  .toHTML(title); // Returns HTML-formatted string
```

### 4. Deduplication Strategies

We occasionally receive multiple calls from QuickNode for the same event.
To avoid firing multiple notifications for the same event, we deduplicate events
by generating and caching unique event IDs. The unique event ID component depends
on the type of event.

Choose the appropriate deduplication strategy for your event:

- **`proposalId`**: For proposal-related events (created, queued, executed, canceled)
- **`transactionHash`**: For one-time transaction events
- **`rateFeedId`**: For oracle/price feed events
- **`custom`**: For complex deduplication logic (requires `customDeduplicationKey` function)

Example of custom deduplication:

```typescript
{
  deduplicationStrategy: "custom",
  customDeduplicationKey: (event) => {
    return `${event.someField}-${event.anotherField}`;
  },
}
```

## Testing New Events

### 1. Create a Test Fixture

Create a JSON fixture file in [`src/events/fixtures/`](src/events/fixtures/) that matches the QuickNode webhook payload format:

```bash
touch src/events/fixtures/your-new-event.fixture.json
```

Example fixture content:

```json
{
  "result": [
    {
      "address": "0x47036d78bb3169b4f5560dd77bf93f4412a59852",
      "blockHash": "0xf0fac639cac5ba78322ebc9d41280577ffd73616ac711e26a47efca776ac005a",
      "blockNumber": "28494094",
      "logIndex": "0x10",
      "name": "YourNewEvent",
      "transactionHash": "0x71c89ff65fe1e7b2ae58f6459959507bc405421efa18159fb4e96b589a140c4f",
      "someField": "example value",
      "anotherField": "12345"
    }
  ]
}
```

### 2. Add pnpm Test Scripts

Add test scripts to [`package.json`](package.json) for both local and production testing:

```json
{
  "scripts": {
    // Add to the general test script
    "test": "pnpm run test:local:ProposalCreated && ... && pnpm run test:local:YourNewEvent",

    // Local testing (tests against http://localhost:8080)
    "test:local:YourNewEvent": "curl -H \"Content-Type: application/json\" -d @src/events/fixtures/your-new-event.fixture.json localhost:8080",

    // Production testing (tests against deployed cloud function)
    "test:prod:YourNewEvent": "./bin/test-deployed-function.sh YourNewEvent"
  }
}
```

**Note:** The script names should match your fixture filename without the `.fixture.json` suffix.

### 3. Update the Test Deployment Script

Add your new event to the switch/case statement in [`bin/test-deployed-function.sh`](bin/test-deployed-function.sh):

```bash
case ${TEST_TYPE} in
"ProposalCreated")
  FIXTURE_FILE="src/events/fixtures/proposal-created.fixture.json"
  ;;
# ... existing cases ...
"YourNewEvent")
  FIXTURE_FILE="src/events/fixtures/your-new-event.fixture.json"
  ;;
*)
  echo "Error: Invalid test type. Must be one of: ProposalCreated, ..., YourNewEvent"
  exit 1
  ;;
esac
```

Also update the error messages at the top and bottom of the script to include your new event type in the list of valid options.

### 4. Run Local Tests

```sh
# Start the local development server
pnpm run dev

# In a separate terminal, run your test
pnpm run test:local:YourNewEvent

# Or run all tests
pnpm test
```

This will:

1. Send the fixture payload to your local cloud function
2. Trigger validation, deduplication, and message composition
3. Send test notifications to Discord and Telegram test channels

### 5. Run Production Tests

```sh
# Test against the deployed cloud function
pnpm run test:prod:YourNewEvent
```

**⚠️ Important:** Production tests send real notifications to test channels. Remember to clean up test messages afterward to avoid spamming channel members.

### 6. Verify Test Results

Check that:

- ✅ Event validation passes (no validation errors in logs)
- ✅ Deduplication works correctly (duplicate events are ignored)
- ✅ Discord message appears in the test channel with correct formatting
- ✅ Telegram message appears in the test channel with correct formatting
- ✅ All links work and point to the correct resources
- ✅ No errors in the cloud function logs (`pnpm run logs`)

### 7. Deploy to Production

Once all tests pass, deploy the updated cloud function:

```sh
# Option 1: Deploy via Terraform (recommended)
pnpm run deploy

# Option 2: Deploy via gcloud CLI (faster, but creates terraform state drift)
pnpm run deploy:function
```

**What happens:**

1. Your TypeScript code is compiled to JavaScript
2. The cloud function is updated with the new event handler
3. QuickNode starts sending matching events to your function
4. Events are validated, deduplicated, and notifications are sent

**Final verification:**

- Monitor the cloud function logs: `pnpm run logs`
- Wait for a real event to occur on-chain (or trigger one if possible)
- Verify that notifications appear in the production Discord and Telegram channels
- Check that the event data is formatted correctly

## Summary

The complete workflow for adding a new event:

1. ✅ **Set up QuickNode webhook** - Create temporary webhook, develop filter function, test with real blockchain data
2. ✅ **Create fixture** - Use real QuickNode response as your test fixture
3. ✅ **Migrate to Terraform** - Delete manual webhook, create Terraform resource
4. ✅ **Implement TypeScript handler** - Define types, add config, implement message builders
5. ✅ **Test locally** - Verify event validation and notification formatting
6. ✅ **Deploy to production** - Update cloud function and monitor for real events

This workflow ensures that your event handler is based on real data and thoroughly tested before going live!
