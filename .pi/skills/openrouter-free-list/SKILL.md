---
name: openrouter-free-list
description: Lists every OpenRouter model that is currently in the free tier (pricing.prompt and pricing.completion are both 0) and returns the result as CSV. Use this skill whenever you need an up-to-date catalog of free OpenRouter models.
---

# OpenRouter Free‑Model lister

This skill fetches the live OpenRouter model catalog (`https://openrouter.ai/api/v1/models`) and filters for models whose `pricing.prompt` and `pricing.completion` are both `0`, i.e. free to use.

## Usage

```bash
scripts/fetch-free-models.sh             # print CSV to stdout
scripts/fetch-free-models.sh --pretty    # print a markdown table instead
```

You can also let pi do the work:

```
/skill:openrouter-free-list --pretty
```