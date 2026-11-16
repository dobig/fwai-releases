# Product usage data

fwai sends no product usage data by default.

To collect usage events from your own servers in your own PostHog project, set
`T3CODE_TELEMETRY_ENABLED=true`, `T3CODE_POSTHOG_KEY`, and `T3CODE_POSTHOG_HOST` in the server's
environment before starting it. Events include the provider, model, reasoning effort, permission
mode, turn result, duration, release channel, and main-agent token totals when available. They do
not include prompts, responses, file contents, authentication tokens, conversation IDs, raw
provider events, or child-agent output.

The desktop app reads these variables from your shell profile (for example `~/.zshrc`) on macOS
and Linux, so export them there and restart the app. On Windows, set them as user environment
variables.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > General > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
