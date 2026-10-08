import os
import sys
import json
import importlib.util
from typing import Dict, Any

class AetherToolRunner:
    def __init__(self, manifest_path: str = "studio-aether-engine/master_tool_manifest.json"):
        self.manifest_path = manifest_path
        with open(self.manifest_path, "r", encoding="utf-8-sig") as f:
            self.manifest = json.load(f)

    def _resolve_file_path(self, raw_path: str) -> str:
        # Check relative to cwd first, then check inside studio-aether-engine
        candidates = [
            os.path.abspath(raw_path),
            os.path.abspath(os.path.join("studio-aether-engine", raw_path)),
            os.path.abspath(os.path.join("..", raw_path))
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                return candidate
        return os.path.abspath(raw_path)

    def execute(self, tool_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if tool_id not in self.manifest:
            raise KeyError(f"Tool ID '{tool_id}' missing from registry.")

        meta = self.manifest[tool_id]
        raw_path = meta["file_path"]
        resolved_path = self._resolve_file_path(raw_path)

        if not os.path.exists(resolved_path):
            return {
                "status": "ERROR",
                "message": f"File not found at resolved path: {resolved_path} (raw: {raw_path})"
            }

        # Handle Markdown Prompts / Skills
        if meta.get("type") == "MARKDOWN_PROMPT":
            with open(resolved_path, "r", encoding="utf-8", errors="ignore") as f:
                return {
                    "status": "SUCCESS",
                    "type": "PROMPT_TEMPLATE",
                    "tool_id": tool_id,
                    "template": f.read()[:300] + "...",
                    "context_payload": payload
                }

        # Handle Native Python Functions
        repo_dir = os.path.dirname(resolved_path)
        for p in [os.getcwd(), repo_dir]:
            if p not in sys.path:
                sys.path.insert(0, p)

        func_name = meta["name"]
        module_name = os.path.basename(resolved_path).replace(".py", "")

        spec = importlib.util.spec_from_file_location(module_name, resolved_path)
        if spec is None or spec.loader is None:
            return {"status": "ERROR", "message": f"Could not load spec for {resolved_path}"}

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        func = getattr(module, func_name)
        result = func(**payload)
        return {"status": "SUCCESS", "type": "PYTHON_EXECUTION", "output": result}

if __name__ == "__main__":
    runner = AetherToolRunner()
    
    # Test 1: Test Markdown Skill Resolution
    markdown_keys = [k for k, v in runner.manifest.items() if v.get("type") == "MARKDOWN_PROMPT"]
    if markdown_keys:
        sample_md = markdown_keys[0]
        res_md = runner.execute(sample_md, {})
        print(f"\n[Test 1] Executed Markdown Skill '{sample_md}':")
        print(f"Status: {res_md['status']}")

    # Test 2: Test Python Function Execution
    python_keys = [k for k, v in runner.manifest.items() if v.get("type") == "PYTHON_NATIVE"]
    print(f"\n[Test 2] Loaded {len(python_keys)} native Python tools in registry.")
