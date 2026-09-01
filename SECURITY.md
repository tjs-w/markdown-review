# Security policy and boundaries

Report suspected vulnerabilities privately through the repository owner's GitHub security contact rather than a public issue when disclosure could expose users.

FlowZone's shipped boundary is one local stdio server running as the current OS user. It is not a privilege boundary or an OS sandbox. Review plugins, CLI adapters, and backend registrations before bundling them.

The public attack surface is one strict router tool. Registrations are static, copied at startup, bounded, and schema-validated. Component helpers are centrally marked app-only. Complete Markdown, image bytes, and UI payloads remain private MCP metadata. Stable errors omit request content, secrets, backend bodies, raw stderr, and unexpected exception text.

CLI adapters use absolute canonical paths, fixed argv/cwd/environment configuration, `shell: false`, JSON stdin, bounded stdout/stderr, integrity checks, cancellation, and timeouts. Never register a shell executable or put model-controlled data in command fields. HTTP adapters use fixed HTTPS endpoints, runtime credentials, no redirects, bounded streaming, and strict response validation.

The universal UI declares an empty network/resource/frame CSP allowlist and only clipboard-write permission. Each view validates its private payload before rendering. Plugin-specific policies—including path containment, file identity, authorization, and tenant access—remain mandatory and are not replaced by router validation.
