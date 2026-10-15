import importlib
from pathlib import Path
import traceback

from comfy_api.latest import ComfyExtension, io

WEB_DIRECTORY = "./web"
NODES = []
__all__ = ["WEB_DIRECTORY"]


this_dir = Path(__file__).parent
for file in (this_dir / "nodes").glob("*.py"):
    if file.name.startswith("__"):
        continue
    module_name = f".nodes.{file.stem}"
    try:
        module = importlib.import_module(module_name, package=__name__)
        if hasattr(module, "NODE"):
            for node_class in module.NODE:
                node_class.define_schema()
                NODES.append(node_class)
    except Exception:
        print(f"\n[SuperUI] Failed to load node module: {module_name}")
        traceback.print_exc()


class SuperUIExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return NODES


async def comfy_entrypoint() -> ComfyExtension:
    return SuperUIExtension()


__all__.append("comfy_entrypoint")
