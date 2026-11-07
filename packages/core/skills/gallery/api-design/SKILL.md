---
name: api-design
description: Designing or changing an HTTP/JSON API (REST style) or a public library interface: resources, naming, errors, pagination, versioning and compatibility. Use before adding endpoints or changing request and response shapes.
license: MIT
---

# API design

## Start from the callers
- Write down who calls the API and the two or three things they need to do. Design requests for those tasks, not around the database tables.
- Find the conventions the codebase already has (naming case, error shape, auth, pagination) and follow them; consistency beats a better idea used once.

## Shape
- Resources are plural nouns (`/projects/{id}/members`); actions that are not create/read/update/delete get a sub-resource or a clear verb endpoint (`POST /invoices/{id}/send`).
- Methods mean what HTTP says: GET is safe and cacheable, PUT replaces and is idempotent, PATCH changes part, DELETE is idempotent. POST creates or runs something; accept an idempotency key for operations that must not happen twice (payments, emails).
- Status codes: 200/201/204 for success (201 with a `Location`), 400 invalid input, 401 not signed in, 403 not allowed, 404 not found, 409 conflict, 422 for validation if the project uses it, 429 with `Retry-After`, 5xx only for faults on the server.
- One error format everywhere, for example `{ "error": { "code": "invalid_email", "message": "...", "field": "email" } }` or RFC 9457 problem details. Codes are stable and machine-readable; messages are for people.
- Lists are paginated from day one (cursors for data that changes, a limit with a maximum), filtered by explicit parameters and sorted in a stated order.
- Timestamps in ISO 8601 UTC, money as integer minor units plus a currency, ids as opaque strings.

## Compatibility
- Adding optional fields and endpoints is safe. Renaming, removing, changing a type or making a field required breaks callers: version it (`/v2`, a header) or serve both shapes during a deprecation period.
- Callers ignore unknown fields; servers never depend on field order.

## Security
- Authenticate every endpoint unless it is public on purpose, and authorise per object: check the caller may see this record, not only that they are signed in.
- Validate input at the boundary with a schema; cap body size, list length and page size. Never return stack traces, internal ids you do not mean to expose, or secrets.

## Deliver
- Update the API description the project keeps (OpenAPI, a docs page, a typed client) in the same change, with an example request and response.
- Add tests for the success path, validation errors, authorisation failures and pagination edges.
