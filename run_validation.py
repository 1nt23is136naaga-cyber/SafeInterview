import sys
sys.path.insert(0, 'backend')
from validation import run_validation
import json

r = run_validation()
print(r['summary'])
for x in r['results']:
    print(f"  {x['scenario_id']}: {x['status']} | score={x['final_score']} risk={x['risk_level']} conf={x['confidence_score']}%")
