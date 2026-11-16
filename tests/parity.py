import json, sys
from spanwell.__main__ import execute

print(json.dumps([execute(p) for p in json.load(sys.stdin)], separators=(",", ":")))
