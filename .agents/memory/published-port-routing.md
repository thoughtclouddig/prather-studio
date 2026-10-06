---
name: Published port routing
description: Diagnose a generic published-site 500 before changing application logic.
---

Reserved VM publishing requires a single exposed external port. When services are removed or a multi-artifact setup is replaced, check for stale port mappings before changing application code.

**Why:** The published site returned a bare 500 despite successful-build metadata and a working development login. Cleaning stale port mappings did not resolve it; fresh deployment logs subsequently exposed a startup crash. A build's success and a local page's health do not verify a production repair. Official Replit documentation also warns that exposing multiple ports can cause publishing failures.

**How to apply:** Confirm the current production service and its port configuration, but do not infer the root cause from a generic 500 alone. Fetch startup logs again after a republish if earlier logs were unavailable. Verify live HTTP responses after the user republishes; never declare the live site fixed based only on local checks or build metadata.
