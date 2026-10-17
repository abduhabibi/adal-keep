#!/usr/bin/env python3
"""Make webui.py fast. Reduces all the artificial waits."""
import pathlib, re, sys

p = pathlib.Path("webui.py")
if not p.exists():
    sys.exit("webui.py not found")

s = p.read_text()

# 1. Reduce stable/confirm windows
s = s.replace("STABLE_SECONDS   = 3.0", "STABLE_SECONDS   = 0.9")
s = s.replace("STREAM_CONFIRM   = 2.0", "STREAM_CONFIRM   = 0.4")

# 2. Kill the 15s dead-wait for the stop-button selector
s = s.replace(
    "    saw_stream = False\n    while time.time() - start < 15:",
    "    saw_stream = False\n    while time.time() - start < 2:",
)

# 3. Poll faster (0.4s → 0.12s)
s = s.replace("        time.sleep(0.4)\n    return last\n\n\ndef truncate",
              "        time.sleep(0.12)\n    return last\n\n\ndef truncate")
s = s.replace("            time.sleep(0.3)\n        return last_code_block(page)",
              "            time.sleep(0.12)\n        return last_code_block(page)")
s = s.replace("            time.sleep(0.3)\n    return last_code_block(page)",
              "            time.sleep(0.12)\n    return last_code_block(page)")

# 4. Shrink the human pauses (nearly eliminate)
s = s.replace("def human_pause(lo=120, hi=420):", "def human_pause(lo=20, hi=60):")
s = s.replace("    human_pause(250, 650)", "    human_pause(60, 120)")
s = s.replace("    page.wait_for_timeout(150)", "    page.wait_for_timeout(40)")

p.write_text(s)
print("webui.py patched — restarted script will run ~20s faster per step")