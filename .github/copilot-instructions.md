# Copilot PR Review Instructions

## Review scope
- Focus on correctness, security, performance, and deprecated APIs.
- Flag missing tests when behaviour changes or new features land.
- Prefer precise, actionable comments over summaries when issues exist.
- For stylistic nits, suggest fixes only if the repository enforces them.

## Required checks before approval
- Ensure the description explains *what* changed and *why*.
- Verify that new endpoints, configs, or scripts are documented.
- Confirm migrations or data changes include rollback notes.
- Look for added secrets, credentials, or tokens committed by mistake.

## Tests and validation
- Confirm automated tests cover the new functionality.
- If tests are absent or incomplete, request them or supply a test plan summarising the manual steps required to validate the change.
- For flaky or long-running suites, suggest targeted smoke tests that cover the risk surface.

## Tone and style
- Keep feedback concise, professional, and specific.
- Reference files and lines when calling out problems.
- Offer concrete remediation ideas alongside critiques.
- Acknowledge improvements or clever solutions when applicable.
