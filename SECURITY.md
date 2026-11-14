# Security

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/k-ishida814/decision-workspace/security/advisories/new),
not in a public issue.

Things worth reporting include anything that lets another local user or process read or change
your decisions (the daemon socket is meant to be owner-only), makes the hook block or change
Claude Code's behaviour beyond answering questions, or makes the agents act outside their
read-only tools.

Only the latest release is supported.
