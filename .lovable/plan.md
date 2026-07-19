# TaskFlow — Round 2 Improvements

## 1. Google Calendar (per-user, two-way-ish sync)

- Use the Google Calendar App User Connector so each user connects their own Google account.
- New table `app_user_connections` stores each user's encrypted connection key.
- New server fns: `startGoogleCalendarConnect`, `completeGoogleConnect`, `getGoogleStatus`, `disconnectGoogle`, plus internal helpers to `pushTaskToGoogle` / `deleteFromGoogle`.
- New tasks columns: `google_event_id`, `google_calendar_id`.
- Behavior: after a task is created/edited/deleted, if the user is connected, mirror the change to their `primary` Google Calendar. Also add a "Pull today from Google" action so their existing GCal events show inside TaskFlow (read-only rows) — non-destructive.
- Dashboard header shows a real "Connect Google" button that opens the OAuth popup; once connected it shows the account and a disconnect option.

## 2. Duplicate-task bug fix

Root cause: the AI is fed existing upcoming events for context and sometimes re-emits them when a follow-up ("organize my day") comes in. Fixes:

- Prompt update: explicit rule "NEVER re-schedule an event that already appears in Existing upcoming events."
- Server-side dedupe: before insert, drop any task whose title+start_at match an existing row within a 15-minute window for the same user.

## 3. Drag-and-drop scheduling

- Calendar rows become droppable per-day; task cards become draggable via HTML5 DnD (no new deps).
- Dropping onto another day keeps the time-of-day and moves the date; PATCH updates `start_at`/`end_at`.
- Optimistic update through React Query.

## 4. Conflict warnings

- Compute overlaps client-side per day; overlapping tasks render with an amber "Conflict" badge and a tooltip listing which events overlap.
- On edit save, if the new slot conflicts, toast a warning (still allow save — user's choice).

## 5. Recurring events

- New tasks columns: `recurrence` (`none | daily | weekdays | weekly | monthly`), `recurrence_until` (nullable timestamptz), `series_id` (uuid, nullable — groups a series).
- Create dialog and edit dialog gain a "Repeat" select.
- On create with recurrence, the server expands occurrences up to `recurrence_until` (or 8 weeks default), all sharing `series_id`.
- Delete/edit prompts "Only this event" vs "This and following" for series members.

## 6. Fully-editable settings

- `PreferencesDialog` grows to cover every onboarding field: earliest/latest hour, work style, focus/break minutes, goals, reserved blocks. Onboarding stays as the first-run wizard but Settings is now the superset.

## 7. Small polish

- New-chat button also clears the composer state.
- Toast shows number of duplicates skipped when dedupe kicks in.

---

## Technical notes

- Connector: `connector_app_user--list_connectors` → pick `google_calendar` → `connector_app_user--connect_client` (you'll approve a workspace OAuth client).
- Encryption: `APP_USER_CONNECTION_KEY_SECRET` is auto-provisioned after the connector is linked; helper module `src/lib/connectionKeyCrypto.server.ts` wraps AES-256-GCM.
- Google API calls go through `callAsAppUser` against `/calendar/v3/calendars/primary/events`.
- Recurrence expansion runs in `createTasks` on the server so all rows exist as real DB rows (keeps drag/drop and Google sync simple).
- No new deps; DnD uses native drag events.
