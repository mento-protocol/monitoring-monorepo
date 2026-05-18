import type { ZodIssue } from "zod";

/**
 * Thrown when a `schema` is provided to `useGQL` and the Hasura response fails
 * Zod validation. Carries the Zod issues so callers / error reporters can
 * surface exactly which fields drifted.
 *
 * SWR surfaces this via its standard error path (the `error` property on the
 * returned SWRResponse), so existing error-boundary and `<ErrorBox>` patterns
 * pick it up without any extra wiring.
 */
export class GraphQLSchemaError extends Error {
  readonly issues: ZodIssue[];

  constructor(issues: ZodIssue[], queryHint?: string) {
    const prefix = queryHint ? `[${queryHint}] ` : "";
    super(
      `${prefix}GraphQL response failed schema validation: ${issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "GraphQLSchemaError";
    this.issues = issues;
  }
}
