# Mobile notifications service

The Local Host owns the durable notification feed, per-installation read markers, and push outbox.
Callers may record only events that passed the current Host owner and stale-run checks. Event
identity comes from the raw V4 envelope; interaction identity comes from `interactionId`.

Feed and outbox insertion share one SQLite transaction. The logical uniqueness key is backend,
workspace identity (path fallback), session, and source event ID. Outbox workers claim records in a
write transaction and every completion checks both the lease ID and monotonic fencing token.
Authenticated installation identity is injected by the trusted channel wrapper; renderer arguments
must never choose another installation's read scope. Notification read markers do not update task
read state.

This service owns derived notification facts only. It does not own tasks, sessions, pending runtime
interactions, push credentials, or delivery transport. Retention is 30 days and at most 1,000 rows
per backend. Push TTL and retry policy are enforced by outbox claims.
