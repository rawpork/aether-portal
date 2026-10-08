import json
import subprocess

# Load local manifest tool IDs
with open("studio-aether-engine/master_tool_manifest.json", "r", encoding="utf-8-sig") as f:
    local_manifest = json.load(f)
    local_tools = set(local_manifest.keys())

# Fetch remote tool IDs from D1 with UTF-8 encoding
cmd = 'npx wrangler d1 execute aether_context_db --remote --command="SELECT tool_id FROM tools_manifest;" --json'
res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", shell=True)

try:
    data = json.loads(res.stdout)
    remote_tools = {row["tool_id"] for row in data[0]["results"]}
    missing = local_tools - remote_tools
    
    print(f"\nFound {len(remote_tools)} tools in remote D1 out of {len(local_tools)} local tools.")
    print("Missing tool ID(s):", missing)
    
    for tool_id in missing:
        print(f"\nMissing Tool Details ({tool_id}):")
        print(json.dumps(local_manifest[tool_id], indent=2))
        
except Exception as e:
    print("Error parsing D1 response:", e)
    print("Raw output sample:", res.stdout[:500] if res.stdout else res.stderr[:500])
