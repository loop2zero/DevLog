# DevLog Control Plane Stdout Protocol

DevLog agents can report workflow progress and human approval gates by writing one JSON marker per stdout line. The markers are engine-neutral and do not require the agent to call DevLog APIs.

## Stage Marker

```text
[DEVLOG_STAGE] {"stage":"3/7","desc":"running tests"}
```

Fields:

- `stage`: required string. Short stage label such as `3/7`, `Phase 2`, or `Review`.
- `desc`: optional string. Human-readable current activity.
- `current_stage`: optional string alternative when the agent already has the full display text.

DevLog stores the latest stage as `current_stage`. When both `stage` and `desc` are present, the display value is `stage · desc`.

## Gate Marker

```text
[DEVLOG_GATE] {"question":"Approve the migration plan?","options":["Approve","Revise"],"stage":"2/4","desc":"plan review"}
```

Fields:

- `question`: required string. The human decision prompt.
- `options`: optional string array. Suggested responses for button rendering.
- `stage` / `desc` / `current_stage`: optional stage context for the gate.

DevLog stores the gate as JSON in `gate_status` with an internal `id`, `question`, `options`, `created_at`, and `stage`.

## Compatibility

Agents that do not emit these markers continue to work with the existing lifecycle status display. Malformed markers are left as ordinary visible output instead of failing the session.
