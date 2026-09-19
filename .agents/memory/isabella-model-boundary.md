---
name: Isabella model boundary
description: Product boundary for Isabella's no-key, local-first assistant behavior.
---

Isabella should remain honest about what runs locally. The current product can answer lightweight prompts in-browser and perform public-source lookups for changing facts; it is not a newly trained billion-parameter model.

**Why:** The user requested a no-API assistant, but training and hosting a new frontier-scale model is not feasible inside a normal web app artifact. Clear source labels and explicit research behavior preserve trust.

**How to apply:** When adding answer capabilities, prefer local deterministic logic or a clearly labeled retrieval path. If a real LLM is added later, disclose the provider/runtime boundary in the UI or settings instead of silently presenting it as locally trained.