# Security Policy

truecopy vets, signs, and pins Claude Code skills and MCP servers before an agent runs them — the supply-chain gate for AI agents. Vulnerability reports get priority attention.

## Reporting a vulnerability

Please **do not open a public issue** for security reports.

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/askalf/truecopy/security/advisories/new) — creates a private advisory visible only to maintainers.
- **Email:** support@askalf.org with `truecopy security` in the subject.

You'll get an acknowledgement within 72 hours. Please include a minimal reproduction where possible.

## Supported versions

truecopy is pre-1.0: only the latest release receives security fixes; there are no maintenance branches.

## In scope

Anything that breaks the core promise — no unvetted skill or MCP server reaches the agent:

- A poisoned or tampered skill/plugin passing verification (bad signature or drifted pin accepted as valid)
- Pin bypass: a fetched artifact whose content doesn't match its pinned SHA being accepted as genuine
- The scanner failing to flag an injection or exfiltration pattern it claims to cover
- Signature or provenance forgery that makes an untrusted publisher appear trusted
- Audit-trail tampering or bypass
