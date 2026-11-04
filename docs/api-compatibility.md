# API compatibility

The server and the apps (Android, Windows, and the web app when it isn't served by the server itself) are released
separately. People update their server and their phone on different days, so **any app release has to work against
the previous server release, and any server release has to work against the previous app release.** This document is
how we keep that true, and what to do on the rare occasion it can't be.

## How a mismatch is handled

Every API change belongs to an **API version**, a single integer (`API_VERSION` in `packages/api/src/schemas.ts`).
It is bumped only for a breaking change, never for an additive one.

* Every request an app makes carries `X-Beatseam-Api: <version it speaks>`.
* Every `/api/v1` response carries `X-Beatseam-Api-Versions: <versions the server speaks>` (from
  `SUPPORTED_API_VERSIONS`). A server too old to send it is read as speaking version 1.
* A server answers **426** (`code: api_version_unsupported`) to a request naming a version it doesn't speak.
* `ApiClient` compares the advertised versions with its own on every response, so the check happens on the very first
  request, before any data is parsed, and throws `ApiVersionError`. Its message already says which side has to
  update ("update the app" when the server has moved on, "update the server" when the app is ahead), and it is shown
  where sign-in and sync errors are shown.

So a breaking change doesn't corrupt anything or fail with a confusing parse error: the old app stops with a clear
"update the app" message and keeps its already-synced library visible. That is the safety net. **It is not
permission to break things**, because it still strands people until they update, and on a phone that can mean
waiting for a store release.

## The rules for changes to the wire format

"The wire format" is everything an app and a server both have to agree on: the routes under `/api/v1`, the request
and response schemas in `packages/api`, the sync change feed and the mutation queue, track keys and their
encoding, the sign-in and device-code flow, and the offline-download hash/size contract.

### Allowed without a version bump (additive)

* A new endpoint, or a new optional query parameter.
* A new field on a **response**. Clients ignore keys they don't know (the schemas are not `.strict()`). Keep it that
  way: don't add `.strict()` to a response schema.
* A new optional field on a **request**, which the server must treat as absent when an older app doesn't send it.
* A new `code` on an error response, as long as the status code is one the app already handles generically.

### Additive, but only if you also do this

* **A new field on a response that the new app needs.** An old server won't send it, so the app's schema must make it
  `.optional()` or `.default(...)`, and the app must work without it (degrade the feature, don't crash). Make it
  required in a later release once old servers are out of the picture, and only then.
* **A new value in an enum** (`z.enum`). Old apps fail to parse it. Either give the field a catch-all the app already
  copes with, or treat it as breaking. Prefer a new optional field over a new enum value.
* **A new thing the server expects an app to do** (for example a new kind of mutation). Old apps will never do it, so
  the server must keep working without it.
* **A new required field on a request.** Old apps won't send it. Accept its absence and fill a default instead.

### Breaking (needs a version bump and a deprecation window)

* Removing or renaming a route, a field, or an enum value.
* Changing a field's type, units, or meaning (e.g. seconds to milliseconds; a track key's encoding).
* Making an optional request field required, or tightening validation so something an old app sends is now refused.
* Changing how authentication, the device-code flow or sessions work in a way an old app can't follow.
* Changing sync semantics: what a change feed entry means, how cursors resume, how conflicts resolve.
* Anything that makes a persisted client-side copy (the synced library, the mutation queue, kept lyrics) unreadable
  or wrong for the next release of the app.

If you're unsure which side of the line a change is on, treat it as breaking and talk to a maintainer first.

## Avoiding a break (preferred)

Almost every breaking change can be turned into a non-breaking one with *expand, then contract*:

1. **Expand.** Add the new field/route next to the old one. Server writes both, accepts both.
2. **Migrate.** Ship the app that reads the new one (falling back to the old when absent).
3. **Contract.** Several releases later, once old apps are rare, stop writing the old one. Only that last step is
   breaking, and by then you may be able to drop it without anyone noticing.

Other habits that keep things compatible:

* Prefer adding to the end of formats and defaults you can change later over clever packing.
* Don't reuse a name for something with different meaning. Pick a new name.
* Put new behaviour behind a capability the server advertises (a field on `/auth/status` or `/auth/me`) rather
  than guessing from the version number, so an app can offer the feature only where it works.
* Never let a *client* depend on a server being newer than "the previous release", and never let a *server* depend on
  an app being newer than "the previous release".

## When a breaking change is truly unavoidable

1. Bump `API_VERSION` in `packages/api/src/schemas.ts`.
2. Keep serving the old version for a deprecation window: add the old number to `SUPPORTED_API_VERSIONS`, and keep the
   old behaviour working next to the new, so apps that haven't updated yet still work. The server reads the version
   the app sent (`X-Beatseam-Api`) and picks the behaviour. The window is **at least two app releases**, and until
   the new app is available on every store we ship to.
3. Ship the **app first**, with the server following later where you can, so the new app is already out there when
   servers start requiring it. State the order in the release notes.
4. Add tests for both versions while both are supported (see `apps/server/test/httpHardening.test.ts` for how
   negotiation is tested).
5. Remove the old version from `SUPPORTED_API_VERSIONS` only after the window, and say so in the release notes. From
   that point old apps get the "update the app" message instead of a half-working experience.
6. Update this document if the rules themselves changed.

Dropping a version is itself a breaking change. Do it deliberately, not as a side effect of a refactor.

## Checklist for a pull request that touches the API

* [ ] Is every schema/route change in the "allowed" or "only if" list above? If it is breaking, is there a bump, a
      window, and a note about release order?
* [ ] Does the new app still work against the previous server (new response fields optional with a fallback)?
* [ ] Does the new server still work against the previous app (new request fields optional, nothing removed)?
* [ ] Did you add or update a test in `packages/api` or `apps/server/test` that would fail if the change broke an
      old client?
* [ ] If you touched `SUPPORTED_API_VERSIONS`, did you update `docs/api-compatibility.md` and add release notes?
