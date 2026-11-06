#!/usr/bin/env python3
"""Writes tests/signer_read.txt from tests/psbt/signer_read.txt.in, putting in the
QR texts of tests/psbt/electrum_made.json where it says @name@.

    python3 tests/psbt/make_scenario.py
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
made = {m["name"]: m["qr"] for m in json.load(open(os.path.join(HERE, "electrum_made.json")))["made"]}
text = open(os.path.join(HERE, "signer_read.txt.in")).read()
text = re.sub(r"@([a-z0-9-]+)@", lambda m: made[m.group(1)], text)
with open(os.path.join(HERE, "..", "signer_read.txt"), "w") as f:
    f.write(text)
