import * as Sentry from "@sentry/nextjs";
import { getServerSentryOptions } from "./sentry.shared";

Sentry.init(getServerSentryOptions());
