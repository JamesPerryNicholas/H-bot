# Scheduled tasks from chat

Date: 2026-11-10

The desktop app already runs scheduled tasks through DSH (Settings → Scheduled tasks, and the schedule_* tools). Bots were not told to use them, so a request like a daily reminder could end as a promise to remember.

Change: add one shared team rule so every Bot, including the Main Bot, calls `schedule_create` in its own chat when the user wants a reminder or a time-based repeating task, confirms the name, work and time, checks for duplicates, and uses `schedule_edit` to change or stop a task the user names. If the tools are unavailable, it points the user to Settings → Scheduled tasks.

This does not copy any third-party product text. Tool target stays `this_session`, as the host already requires.
