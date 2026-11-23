---
name: transitions
description: Settings → Transitions copies an agency from EasyEnjaz, EnjazPlus, Musaned, Pextran; generic reader, tested only on a mock site
metadata:
  type: project
---

Built 2026-11-05 in services/transition.js. A person signs in, then a generic reader takes JSON answers and tables, recognises people by a passport number and saves raw data in data/transitions/. It was tested only against a local mock site because nobody gave a logged-in view of the real ones.

**Why:** the user is showing Adal Keep to agencies that use these systems.

**How to apply:** when a real run finds few people, read data/transitions/<source>-*/people.json and the run's state before adding a site-specific step; keep it read-only.
