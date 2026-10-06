---
name: Published port routing
description: Diagnose a generic published-site 500 before changing application logic.
---

Reserved VM publishing requires a single exposed external port. When services are removed or a multi-artifact setup is replaced, check for stale port mappings before changing application code.

**Why:** This project retained mappings for retired services while the app was running as a single Next.js service. The published site returned a bare 500 on every path despite successful-build metadata, while the development login worked. Official Replit documentation warns that exposing multiple ports can cause publishing failures or Internal Server Error responses.

**How to apply:** Confirm the current production service, compare its listening port with the published routing configuration, and check the live HTTP response rather than trusting build status alone. Publishing configuration corrections require the user to republish before they affect the live site.
