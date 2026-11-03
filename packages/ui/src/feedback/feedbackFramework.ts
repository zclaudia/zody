import {
  DEFAULT_FEEDBACK_TICKET_FRAMEWORK,
  type ZodyProvider,
  type FeedbackTicketFramework,
} from "@zody/shared";

export function inferFeedbackFrameworkFromAgentProvider(
  _provider: ZodyProvider | null | undefined,
): FeedbackTicketFramework {
  return DEFAULT_FEEDBACK_TICKET_FRAMEWORK;
}
