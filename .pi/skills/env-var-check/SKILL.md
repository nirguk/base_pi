---
name: env-var-check
description: Check if an environment variable is set without exposing its value. Uses parameter expansion to test presence.
---

# Env Var Check Skill

## Usage

```bash
/skill:env-var-check check <var_name>
```

Runs a Bash command like `[ -n "${VAR+x}" ]` to detect if variable is defined; returns presence status without printing value ; to protect potential secrets.

## Implementation

Script located at `scripts/check.sh`.