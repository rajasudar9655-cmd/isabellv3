---
name: Isabella voice provider
description: Provider boundary and endpoint behavior for Isabella's live voice mode.
---

Live voice is a separate capability from text chat. NVIDIA's hosted speech APIs expose model-specific invocation endpoints: Parakeet CTC for transcription and Magpie Multilingual for female English speech synthesis. The voice credential must only be used by voice routes, never exposed to the browser or reused by ordinary text chat.

**Why:** The generic NVIDIA model gateway lists text models, while hosted speech endpoints use different URLs and request formats. Treating them as one OpenAI-compatible endpoint caused retired-model and 404 failures.

**How to apply:** Keep microphone audio server-side, convert recordings to mono 16 kHz WAV before ASR, and return synthesized WAV audio as a browser-playable response. Verify model-specific endpoints against NVIDIA's current catalog before changing them.